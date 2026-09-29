import { SLASH_COMMANDS } from './slashCommands';

// Webview script sources. The exported fragments are spliced into CONTENT_JS;
// SESSIONS_PANEL_JS also uses the `vscode` API handle CONTENT_JS declares; specs inject it.

/** Tool-call status helpers: a group is running while any entry is non-terminal. */
export const TOOL_STATUS_JS = `
            var TERMINAL_STATUSES = ['done', 'error', 'failed', 'cancelled'];

            function isFailedStatus(status) {
                return status === 'error' || status === 'failed';
            }

            function getToolGroupStatus(entries) {
                if (entries.some(function(entry) { return TERMINAL_STATUSES.indexOf(entry.status) === -1; })) {
                    return 'running';
                }
                if (entries.some(function(entry) { return isFailedStatus(entry.status); })) {
                    return 'error';
                }
                if (entries.some(function(entry) { return entry.status === 'cancelled'; })) {
                    return 'cancelled';
                }
                return 'done';
            }

            function shouldOpenToolGroup(groupStatus) {
                return groupStatus === 'running' || groupStatus === 'error';
            }

            function getToolStatusSymbol(status) {
                if (status === 'done') { return '\u2713'; }
                if (isFailedStatus(status)) { return '\u2717'; }
                if (status === 'cancelled') { return '\u2298'; }
                return '\u27F3';
            }

            function getToolStatusClass(status) {
                if (status === 'done') { return ' tool-ok'; }
                if (isFailedStatus(status)) { return ' tool-fail'; }
                if (status === 'cancelled') { return ' tool-cancel'; }
                return ' tool-run';
            }
`;

/** Sessions menu: opened per pane, keyboard-navigable, replies carry the pane's threadId. */
export const SESSIONS_PANEL_JS = `
            var sessionsPanelDismiss = null;
            var sessionsPanelPendingTimer = null;
            var sessionsPanelThreadId = '';
            var sessionsRequestThreadId = '';
            var sessionsPanelRows = [];
            var sessionsRefreshTimer = null;

            /** Coalesces a burst of session index changes into one reload of an open panel. */
            var SESSIONS_REFRESH_DELAY_MS = 300;

            var SESSIONS_ROW_STYLE = 'cursor:pointer;padding:3px 6px;border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;width:100%;text-align:left;background:none;border:none;color:inherit;font:inherit';

            function requestSessionsPanel(threadId) {
                sessionsPanelThreadId = threadId || '';
                sessionsRequestThreadId = sessionsPanelThreadId;
                vscode.postMessage({ type: 'requestSessions', threadId: sessionsPanelThreadId });
            }

            /** The user moved on before the list arrived: a late reply must not open over their work. */
            function cancelSessionsRequest() {
                sessionsRequestThreadId = '';
            }

            function isAwaitedListing(listing) {
                return Boolean(sessionsRequestThreadId) && (!listing.threadId || listing.threadId === sessionsRequestThreadId);
            }

            function describeSessionRow(session) {
                var label = session.label || session.sessionKey || '';
                if (session.hasActiveRun) { label = '\\u25CF ' + label; }
                if (session.cold) { label = '\\u2744 ' + label; }
                return label;
            }

            function getSessionsPanelNotice(listing) {
                if (listing.error) { return String(listing.error); }
                return (listing.sessions || []).length === 0 ? 'No sessions' : '';
            }

            function createSessionsRow(text) {
                var row = document.createElement('button');
                row.setAttribute('role', 'menuitem');
                row.setAttribute('tabindex', '-1');
                row.style.cssText = SESSIONS_ROW_STYLE;
                row.textContent = text;
                return row;
            }

            function createSessionRow(session, threadId) {
                var row = createSessionsRow(describeSessionRow(session));
                row.title = session.sessionKey || '';
                row.setAttribute('data-session-key', session.sessionKey || '');
                // The panel lives on document.body, outside the pane click delegation.
                row.addEventListener('click', function(ev) {
                    ev.stopPropagation();
                    vscode.postMessage({ type: 'openSession', sessionKey: session.sessionKey || '', threadId: threadId });
                    dismissSessionsPanel();
                });
                return row;
            }

            function createNoticeRow(text) {
                var row = createSessionsRow(text);
                row.setAttribute('aria-disabled', 'true');
                row.style.cssText = SESSIONS_ROW_STYLE + ';cursor:default;opacity:0.7';
                return row;
            }

            function moveSessionsFocus(step) {
                var current = sessionsPanelRows.indexOf(document.activeElement);
                var next = (current + step + sessionsPanelRows.length) % sessionsPanelRows.length;
                sessionsPanelRows[next].focus();
            }

            function handleSessionsPanelKeydown(ev) {
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    dismissSessionsPanel({ restoreFocus: true });
                } else if (ev.key === 'ArrowDown') {
                    ev.preventDefault();
                    moveSessionsFocus(1);
                } else if (ev.key === 'ArrowUp') {
                    ev.preventDefault();
                    moveSessionsFocus(-1);
                }
            }

            function renderSessionsPanel(listing) {
                if (!isAwaitedListing(listing)) {
                    return;
                }
                var threadId = sessionsRequestThreadId;
                var opener = findSessionsButton(threadId);
                var focusWasOnOpener = document.activeElement === opener || document.activeElement === document.body || !document.activeElement;
                var focusedSessionKey = focusedSessionRowKey();
                dismissSessionsPanel();
                sessionsPanelThreadId = threadId;
                var panel = document.createElement('div');
                panel.id = 'claw-sessions-panel';
                panel.setAttribute('role', 'menu');
                panel.setAttribute('aria-label', 'Sessions');
                panel.style.cssText = 'position:fixed;top:32px;right:8px;max-height:60vh;overflow:auto;background:var(--vscode-editorWidget-background, #252526);border:1px solid var(--vscode-editorWidget-border, #454545);color:var(--vscode-editor-foreground, inherit);padding:6px;z-index:60;min-width:220px;font-size:12px';
                var title = document.createElement('div');
                title.setAttribute('aria-hidden', 'true');
                title.textContent = 'Sessions';
                title.style.cssText = 'opacity:0.7;margin-bottom:4px';
                panel.appendChild(title);
                var notice = getSessionsPanelNotice(listing);
                sessionsPanelRows = notice
                    ? [createNoticeRow(notice)]
                    : listing.sessions.map(function(session) { return createSessionRow(session, threadId); });
                sessionsPanelRows.forEach(function(row) { panel.appendChild(row); });
                panel.addEventListener('keydown', handleSessionsPanelKeydown);
                document.body.appendChild(panel);
                if (focusedSessionKey !== null) {
                    (findSessionRow(focusedSessionKey) || sessionsPanelRows[0]).focus();
                } else if (focusWasOnOpener) {
                    sessionsPanelRows[0].focus();
                }
                // Deferred so the click that opened the panel does not dismiss it.
                sessionsPanelPendingTimer = setTimeout(function() {
                    sessionsPanelPendingTimer = null;
                    sessionsPanelDismiss = function(ev) {
                        if (!(ev.target instanceof Node) || !panel.contains(ev.target)) {
                            dismissSessionsPanel();
                        }
                    };
                    document.addEventListener('click', sessionsPanelDismiss);
                }, 0);
            }

            /** The session key of the focused row of an open panel, '' for a notice row, null when focus is elsewhere. */
            function focusedSessionRowKey() {
                var panel = document.getElementById('claw-sessions-panel');
                var active = document.activeElement;
                return panel && active && panel.contains(active) ? (active.getAttribute('data-session-key') || '') : null;
            }

            function findSessionRow(sessionKey) {
                for (var i = 0; i < sessionsPanelRows.length; i++) {
                    if (sessionsPanelRows[i].getAttribute('data-session-key') === sessionKey) { return sessionsPanelRows[i]; }
                }
                return null;
            }

            /** The gateway's session index changed: an open panel reloads its list, keeping the focused row. */
            function refreshSessionsPanel() {
                if (!document.getElementById('claw-sessions-panel') || sessionsRefreshTimer !== null) {
                    return;
                }
                sessionsRefreshTimer = setTimeout(function() {
                    sessionsRefreshTimer = null;
                    if (document.getElementById('claw-sessions-panel')) {
                        requestSessionsPanel(sessionsPanelThreadId);
                    }
                }, SESSIONS_REFRESH_DELAY_MS);
            }

            function dismissSessionsPanel(options) {
                cancelSessionsRequest();
                if (sessionsPanelPendingTimer !== null) {
                    clearTimeout(sessionsPanelPendingTimer);
                    sessionsPanelPendingTimer = null;
                }
                if (sessionsPanelDismiss) {
                    document.removeEventListener('click', sessionsPanelDismiss);
                    sessionsPanelDismiss = null;
                }
                sessionsPanelRows = [];
                var panel = document.getElementById('claw-sessions-panel');
                if (!panel) { return; }
                panel.remove();
                if (options && options.restoreFocus) {
                    var button = findSessionsButton(sessionsPanelThreadId);
                    if (button) { button.focus(); }
                }
            }

            document.addEventListener('click', function(ev) {
                if (!(ev.target instanceof Element) || !ev.target.closest('.pane-btn[data-action="sessions"]')) {
                    cancelSessionsRequest();
                }
            });

            function findSessionsButton(threadId) {
                var buttons = document.querySelectorAll('.pane-btn[data-action="sessions"]');
                for (var i = 0; i < buttons.length; i++) {
                    if (buttons[i].getAttribute('data-thread-id') === threadId) { return buttons[i]; }
                }
                return null;
            }
`;

/** Approval and question rows: built from DOM nodes (text is never parsed as markup), answered with
 *  native buttons and fields, their typed drafts kept across re-renders. Uses CONTENT_JS's `vscode`. */
export const OPERATOR_PROMPTS_JS = `
            var promptDrafts = Object.create(null);

            var DECISION_LABELS = { 'allow-once': 'Approve once', 'allow-always': 'Always allow', 'deny': 'Deny' };

            function promptNode(tag, className, text) {
                var node = document.createElement(tag);
                if (className) { node.className = className; }
                if (text) { node.textContent = text; }
                return node;
            }

            function promptDraft(promptId, questionId) {
                var byQuestion = promptDrafts[promptId] || (promptDrafts[promptId] = Object.create(null));
                return byQuestion[questionId] || (byQuestion[questionId] = { selected: [], other: '' });
            }

            function markPromptControl(control, prompt, threadId, focusKey) {
                control.setAttribute('data-prompt-id', prompt.id);
                control.setAttribute('data-thread-id', threadId);
                control.setAttribute('data-focus-key', prompt.id + '|' + focusKey);
                control.disabled = prompt.state !== 'pending';
                return control;
            }

            function promptButton(prompt, threadId, action, label, primary) {
                var button = promptNode('button', 'prompt-btn' + (primary ? ' prompt-btn-primary' : ''), label);
                button.type = 'button';
                button.setAttribute('data-action', action);
                return markPromptControl(button, prompt, threadId, action);
            }

            function decisionButton(prompt, threadId, decision) {
                var button = promptButton(prompt, threadId, 'prompt-decision', DECISION_LABELS[decision] || decision, decision !== 'deny');
                button.setAttribute('data-decision', decision);
                button.setAttribute('data-focus-key', prompt.id + '|prompt-decision|' + decision);
                return button;
            }

            function formatPromptExpiry(expiresAtMs) {
                var at = new Date(Number(expiresAtMs));
                return isNaN(at.getTime()) ? '' : 'Expires at ' + at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }

            function promptCard(prompt, heading) {
                var card = promptNode('div', 'prompt-card prompt-' + prompt.kind + (prompt.state === 'resolved' ? ' prompt-resolved' : ''));
                card.setAttribute('role', 'group');
                card.setAttribute('aria-label', heading);
                card.setAttribute('data-prompt-id', prompt.id);
                var head = promptNode('div', 'prompt-heading', heading);
                if (prompt.state !== 'resolved') {
                    head.appendChild(promptNode('span', 'prompt-expiry', formatPromptExpiry(prompt.expiresAtMs)));
                }
                card.appendChild(head);
                return card;
            }

            function promptStatus(prompt) {
                var status = promptNode('div', 'prompt-status', prompt.status || '');
                status.setAttribute('role', 'status');
                return status;
            }

            function promptActions(buttons) {
                var actions = promptNode('div', 'prompt-actions');
                buttons.forEach(function(button) { actions.appendChild(button); });
                return actions;
            }

            function renderApprovalCard(prompt, threadId) {
                var card = promptCard(prompt, prompt.subject === 'exec' ? 'Run this command?' : 'Allow this action?');
                card.appendChild(promptNode(prompt.subject === 'exec' ? 'pre' : 'div', 'prompt-title', prompt.title));
                if ((prompt.details || []).length) {
                    var details = promptNode('ul', 'prompt-details');
                    prompt.details.forEach(function(line) { details.appendChild(promptNode('li', '', line)); });
                    card.appendChild(details);
                }
                if (prompt.state !== 'resolved') {
                    card.appendChild(promptActions((prompt.decisions || []).map(function(decision) {
                        return decisionButton(prompt, threadId, decision);
                    })));
                }
                card.appendChild(promptStatus(prompt));
                return card;
            }

            function renderQuestionOption(prompt, question, option, index, threadId) {
                var label = promptNode('label', 'prompt-option');
                var input = document.createElement('input');
                input.type = question.multiSelect ? 'checkbox' : 'radio';
                input.name = 'prompt|' + prompt.id + '|' + question.id;
                input.value = option.label;
                input.className = 'prompt-field prompt-choice';
                input.checked = promptDraft(prompt.id, question.id).selected.indexOf(option.label) !== -1;
                input.setAttribute('data-question-id', question.id);
                label.appendChild(markPromptControl(input, prompt, threadId, question.id + '|' + index));
                label.appendChild(promptNode('span', 'prompt-option-label', option.label));
                if (option.description) {
                    label.appendChild(promptNode('span', 'prompt-option-description', option.description));
                }
                return label;
            }

            function renderQuestionOther(prompt, question, threadId) {
                var input = document.createElement('input');
                var caption = question.options.length ? 'Other answer' : 'Your answer';
                input.type = question.secret ? 'password' : 'text';
                input.className = 'prompt-field prompt-other';
                input.value = promptDraft(prompt.id, question.id).other;
                input.placeholder = caption;
                input.autocomplete = 'off';
                input.setAttribute('aria-label', caption);
                input.setAttribute('data-question-id', question.id);
                return markPromptControl(input, prompt, threadId, question.id + '|other');
            }

            function renderQuestionItem(prompt, question, threadId) {
                var fieldset = promptNode('fieldset', 'prompt-question');
                fieldset.appendChild(promptNode('legend', 'prompt-question-text', question.header ? question.header + ': ' + question.text : question.text));
                question.options.forEach(function(option, index) {
                    fieldset.appendChild(renderQuestionOption(prompt, question, option, index, threadId));
                });
                if (question.allowsOther) {
                    fieldset.appendChild(renderQuestionOther(prompt, question, threadId));
                }
                return fieldset;
            }

            function renderQuestionCard(prompt, threadId) {
                var card = promptCard(prompt, 'The agent asks');
                (prompt.questions || []).forEach(function(question) {
                    card.appendChild(renderQuestionItem(prompt, question, threadId));
                });
                if (prompt.state !== 'resolved') {
                    card.appendChild(promptActions([
                        promptButton(prompt, threadId, 'prompt-answer', 'Send answer', true),
                        promptButton(prompt, threadId, 'prompt-skip', 'Skip', false),
                    ]));
                }
                card.appendChild(promptStatus(prompt));
                return card;
            }

            function renderPanePrompts(thread) {
                var region = promptNode('div', 'pane-prompts');
                region.setAttribute('data-thread-id', thread.id);
                region.setAttribute('aria-live', 'polite');
                region.setAttribute('aria-label', 'Requests waiting for you');
                region.tabIndex = -1;
                (thread.prompts || []).forEach(function(prompt) {
                    region.appendChild(prompt.kind === 'approval' ? renderApprovalCard(prompt, thread.id) : renderQuestionCard(prompt, thread.id));
                });
                return region;
            }

            /** Rebuilds the rows only when they changed, handing focus back to the control that had it. */
            function syncPanePrompts(pane, cache, thread) {
                var prompts = thread.prompts || [];
                var json = JSON.stringify(prompts);
                var live = childWithClass(pane, 'pane-prompts');
                if (live && cache.prompts === json) {
                    return;
                }
                cache.prompts = json;
                var hadFocus = Boolean(live) && live.contains(document.activeElement);
                var focusKey = hadFocus ? document.activeElement.getAttribute('data-focus-key') : null;
                if (!prompts.length) {
                    if (live) { live.remove(); }
                    return;
                }
                var fresh = renderPanePrompts(thread);
                if (live) {
                    live.replaceWith(fresh);
                } else {
                    pane.insertBefore(fresh, childWithClass(pane, 'composer-shell'));
                }
                if (hadFocus) {
                    restorePromptFocus(fresh, focusKey);
                }
            }

            function restorePromptFocus(region, focusKey) {
                var controls = region.querySelectorAll('[data-focus-key]');
                for (var i = 0; i < controls.length; i++) {
                    if (controls[i].getAttribute('data-focus-key') === focusKey && !controls[i].disabled) {
                        controls[i].focus();
                        return;
                    }
                }
                region.focus();
            }

            /** Drafts of prompts no pane shows any more are dropped. */
            function prunePromptDrafts(threads) {
                var shown = Object.create(null);
                threads.forEach(function(thread) {
                    (thread.prompts || []).forEach(function(prompt) { shown[prompt.id] = true; });
                });
                Object.keys(promptDrafts).forEach(function(promptId) {
                    if (!shown[promptId]) { delete promptDrafts[promptId]; }
                });
            }

            function findThreadPrompt(threadId, promptId) {
                var thread = getThreadById(threadId);
                var prompts = (thread && thread.prompts) || [];
                for (var i = 0; i < prompts.length; i++) {
                    if (prompts[i].id === promptId) { return prompts[i]; }
                }
                return null;
            }

            /** A typed answer replaces the chosen option of a single-choice question, and the other way round. */
            function updatePromptDraft(field) {
                var promptId = field.getAttribute('data-prompt-id');
                var questionId = field.getAttribute('data-question-id');
                var prompt = findThreadPrompt(field.getAttribute('data-thread-id'), promptId);
                if (!prompt || !questionId) { return; }
                var draft = promptDraft(promptId, questionId);
                var fieldset = field.closest('.prompt-question');
                var single = field.type === 'radio' || (fieldset && fieldset.querySelector('input[type="radio"]'));
                if (field.classList.contains('prompt-other')) {
                    draft.other = field.value;
                    if (single && field.value) {
                        draft.selected = [];
                        fieldset.querySelectorAll('.prompt-choice').forEach(function(choice) { choice.checked = false; });
                    }
                    return;
                }
                draft.selected = Array.from(fieldset.querySelectorAll('.prompt-choice'))
                    .filter(function(choice) { return choice.checked; })
                    .map(function(choice) { return choice.value; });
                var other = single && fieldset.querySelector('.prompt-other');
                if (other) {
                    draft.other = '';
                    other.value = '';
                }
            }

            function collectPromptAnswers(prompt) {
                var answers = {};
                (prompt.questions || []).forEach(function(question) {
                    var draft = promptDraft(prompt.id, question.id);
                    var other = question.secret ? draft.other : draft.other.trim();
                    var values = question.multiSelect ? draft.selected.slice() : draft.selected.slice(0, 1);
                    if (other) {
                        values = question.multiSelect ? values.concat([other]) : [other];
                    }
                    answers[question.id] = values;
                });
                return answers;
            }

            /** Handles a prompt button; false for every other action. */
            function handlePromptAction(action, actionEl) {
                var promptId = actionEl.getAttribute('data-prompt-id');
                var threadId = actionEl.getAttribute('data-thread-id');
                if (action === 'prompt-decision') {
                    vscode.postMessage({ type: 'resolveApproval', threadId: threadId, promptId: promptId, decision: actionEl.getAttribute('data-decision') });
                    return true;
                }
                if (action === 'prompt-answer') {
                    var prompt = findThreadPrompt(threadId, promptId);
                    if (prompt) {
                        vscode.postMessage({ type: 'answerQuestion', threadId: threadId, promptId: promptId, answers: collectPromptAnswers(prompt) });
                    }
                    return true;
                }
                if (action === 'prompt-skip') {
                    vscode.postMessage({ type: 'answerQuestion', threadId: threadId, promptId: promptId, answers: null });
                    return true;
                }
                return false;
            }

            /** Enter in a typed answer sends the question's answers. */
            function handlePromptKeydown(event) {
                var field = event.target.closest('.prompt-other');
                if (!field || event.key !== 'Enter' || event.isComposing) {
                    return;
                }
                event.preventDefault();
                var card = field.closest('.prompt-card');
                var submit = card && card.querySelector('[data-action="prompt-answer"]');
                if (submit && !submit.disabled) {
                    submit.click();
                }
            }
`;

/** Grid layouts the host accepts for `setDimension`, mirroring the `openclaw.chat.dimension` enum. */
export const GRID_DIMENSIONS = ['1x1', '2x2', '2x3', '3x3', '4x4'];

export const CONTENT_JS = `
        (function() {
            function _showCrash(label, err) {
                var msg = (err && err.stack) ? err.stack : String(err);
                console.error('[OpenClaw] ' + label + ':', err);
                var target = document.getElementById('paneGrid') || document.body;
                var box = document.createElement('details');
                box.className = 'openclaw-crash';
                box.open = true;
                box.innerHTML =
                    '<summary>' + escapeHtml(label) + '</summary>' +
                    '<pre></pre>' +
                    '<div class="openclaw-crash-state">' +
                        'State: threads=' + (typeof state !== 'undefined' ? (state.threads || []).length : '?') +
                        ', dim=' + (typeof currentDimension !== 'undefined' ? currentDimension : '?') +
                    '</div>';
                setLinkifiedText(box.querySelector('pre'), msg);
                target.appendChild(box);
            }

            window.addEventListener('error', function(event) {
                _showCrash('Uncaught error: ' + (event.message || 'unknown'), event.error || event.message);
            });

            window.addEventListener('unhandledrejection', function(event) {
                _showCrash('Unhandled promise rejection', event.reason);
            });

            var vscode = acquireVsCodeApi();
            var paneGrid = document.getElementById('paneGrid');
            var dimensionSelect = document.getElementById('dimensionSelect');
            var btnNew = document.getElementById('btn-new');
            var btnSplit = document.getElementById('btn-split');
            var btnPopout = document.getElementById('btn-popout');

            var slashCommands = ${JSON.stringify(SLASH_COMMANDS.map(c => ({
                name: c.name,
                description: c.description,
                icon: c.icon,
                placeholder: c.placeholder,
            })))};
            var gridDimensions = ${JSON.stringify(GRID_DIMENSIONS)};
            var availableModels = [];
            var recommendations = [];
            var drafts = Object.create(null);
            var messageQueue = Object.create(null);
            var toolGroupOpen = Object.create(null);
            var paneCache = Object.create(null);
            var composing = false;
            var renderDeferred = false;
            var unconfirmedSends = Object.create(null);
            var sendCounter = 0;
            var currentDimension = '1x1';

            var chatTypes = [
                { id: 'chat', label: 'Chat' },
                { id: 'code', label: 'Code' },
                { id: 'review', label: 'Review' },
                { id: 'plan', label: 'Plan' }
            ];

            var composerUi = {
                threadId: '',
                dropdown: '',
                activeSlashIndex: 0,
                activeFileIndex: 0,
                atMentionThreadId: '',
                atMentionStart: -1,
                fileSearchQuery: '',
                fileSearchDebounce: null,
                fileResults: [],
                modelQuery: '',
                dragThreadId: ''
            };

            var state = {
                activeThreadId: '',
                threads: []
            };

            var collapseCompleted = true;
            var hideToolActivity = false;
            var collapseOverrides = Object.create(null); // threadId -> true/false manual override

            function isValidDimension(value) {
                return gridDimensions.indexOf(value) !== -1;
            }

            function getThreadById(threadId) {
                for (var i = 0; i < state.threads.length; i++) {
                    if (state.threads[i].id === threadId) {
                        return state.threads[i];
                    }
                }
                return null;
            }

            function getActiveThread() {
                return getThreadById(state.activeThreadId) || state.threads[0] || null;
            }

            function getDraft(threadId) {
                return drafts[threadId] || '';
            }

            function setDraft(threadId, value) {
                drafts[threadId] = value;
            }

            function escapeHtml(text) {
                var el = document.createElement('span');
                el.textContent = text || '';
                return el.innerHTML;
            }

            function escapeAttr(text) {
                return escapeHtml(text).replace(/"/g, '&quot;');
            }

            /** A non-negative finite number from host data, 0 otherwise: counts are spliced into markup. */
            function toCount(value) {
                var n = Number(value);
                return isFinite(n) && n > 0 ? n : 0;
            }

            /** Compares attributes instead of building a selector, so no id can break or widen the query. */
            function findThreadElement(selector, threadId) {
                var matches = paneGrid.querySelectorAll(selector);
                for (var i = 0; i < matches.length; i++) {
                    if (matches[i].getAttribute('data-thread-id') === threadId) {
                        return matches[i];
                    }
                }
                return null;
            }

            function findPaneBody(threadId) {
                var pane = findThreadElement('.pane', threadId);
                return pane ? pane.querySelector('.pane-body') : null;
            }

            var SAFE_LINK_HREF = /^(https?:|mailto:)/i;

            function removeUnsafeLinks(container) {
                var links = container.querySelectorAll('a[href]');
                for (var i = 0; i < links.length; i++) {
                    if (!SAFE_LINK_HREF.test((links[i].getAttribute('href') || '').trim())) {
                        links[i].removeAttribute('href');
                    }
                }
            }

            function createFileLink(filePath, line, text) {
                var link = document.createElement('span');
                link.className = 'file-link';
                link.setAttribute('data-file-path', filePath);
                if (line) {
                    link.setAttribute('data-line', line);
                }
                link.setAttribute('role', 'link');
                link.setAttribute('tabindex', '0');
                link.textContent = text;
                return link;
            }

            // Longer text nodes stay plain: linking is a convenience, never worth a stalled webview.
            var MAX_LINKIFY_TEXT_LENGTH = 20000;
            var PATH_SEGMENT = /^[\\w.@()-]+$/;

            /** A token as { path, line } when it names a file, else null. Every step is linear in the token. */
            function parseFileReference(token) {
                if (token.indexOf('://') !== -1) {
                    return null;
                }
                var lineMatch = /:(\\d+)(?::\\d+)?$/.exec(token);
                var path = lineMatch ? token.slice(0, lineMatch.index) : token;
                var drive = /^[a-zA-Z]:[\\\\/]/.test(path) ? path.slice(0, 3) : '';
                var rest = path.slice(drive.length);
                if (rest.indexOf(':') !== -1) {
                    return null;
                }
                var segments = rest.split(/[\\\\/]/);
                var isRooted = !drive && segments[0] === '';
                var named = isRooted ? segments.slice(1) : segments;
                if (segments.length < 2 || !named.every(function(segment) { return PATH_SEGMENT.test(segment); })) {
                    return null;
                }
                if (!/.\\.[a-zA-Z0-9]{1,10}$/.test(named[named.length - 1])) {
                    return null;
                }
                return { path: path, line: lineMatch ? lineMatch[1] : '' };
            }

            function linkifyTextNode(textNode) {
                var text = textNode.nodeValue || '';
                if (text.length > MAX_LINKIFY_TEXT_LENGTH) {
                    return;
                }
                var frag = document.createDocumentFragment();
                var lastIndex = 0;
                // One flat character class: runs never overlap, so the scan is linear.
                var tokenPattern = /[\\w.@()\\/\\\\:-]+/g;
                var match;
                while ((match = tokenPattern.exec(text))) {
                    // Sentence punctuation and wrapping parentheses stay prose; trimmed by index, not by regex.
                    var start = match.index;
                    var end = start + match[0].length;
                    while (end > start && '.:)'.indexOf(text.charAt(end - 1)) !== -1) {
                        end -= 1;
                    }
                    while (start < end && text.charAt(start) === '(') {
                        start += 1;
                    }
                    var token = text.slice(start, end);
                    var reference = token && parseFileReference(token);
                    if (!reference) {
                        continue;
                    }
                    frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
                    frag.appendChild(createFileLink(reference.path, reference.line, token));
                    lastIndex = end;
                }
                if (lastIndex === 0) {
                    return;
                }
                frag.appendChild(document.createTextNode(text.slice(lastIndex)));
                textNode.parentNode.replaceChild(frag, textNode);
            }

            /** Plain text as linked DOM, never through markup: no escaping or HTML parse on large bodies. */
            function setLinkifiedText(container, text) {
                var node = document.createTextNode(String(text || ''));
                container.textContent = '';
                container.appendChild(node);
                linkifyTextNode(node);
            }

            /** Links the paths in an element's own text, in place, leaving anchors and existing links alone. */
            function linkifyElement(container) {
                var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
                var textNodes = [];
                while (walker.nextNode()) {
                    var parent = walker.currentNode.parentElement;
                    if (!parent || !parent.closest('a, .file-link, script, style')) {
                        textNodes.push(walker.currentNode);
                    }
                }
                textNodes.forEach(linkifyTextNode);
            }

            function autoResizeTextarea(textarea) {
                if (!textarea) {
                    return;
                }
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
            }

            var userScrolledUp = Object.create(null);

            function isNearBottom(el) {
                if (!el) { return true; }
                return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }

            function scrollPaneToBottom(paneBody, threadId) {
                if (paneBody && (!threadId || !userScrolledUp[threadId])) {
                    paneBody.scrollTop = paneBody.scrollHeight;
                }
            }

            function getThreadStatusLabel(thread) {
                switch (thread.status) {
                    case 'running':
                        return 'Running';
                    case 'complete':
                        return 'Complete';
                    case 'error':
                        return 'Error';
                    case 'cancelled':
                        return 'Stopped';
                    default:
                        return 'Ready';
                }
            }

            function getThreadStatusDetail(thread) {
                switch (thread.status) {
                    case 'running':
                        return 'Generating response \u00b7 Esc stops';
                    case 'complete':
                        return 'Response complete';
                    case 'error':
                        return 'Last run returned an error';
                    case 'cancelled':
                        return 'Generation stopped';
                    default:
                        return 'Enter sends, Shift+Enter new line';
                }
            }

            function formatTokenCount(n) {
                if (n >= 1000000) { return (n / 1000000).toFixed(1) + 'M'; }
                if (n >= 1000) { return (n / 1000).toFixed(1) + 'k'; }
                return String(n);
            }

            function formatContextGauge(used, max) {
                used = toCount(used);
                max = toCount(max);
                var pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
                var level = pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : '';
                return {
                    pct: pct,
                    level: level,
                    label: formatTokenCount(used) + ' / ' + formatTokenCount(max)
                };
            }

            function getContextMax(thread) {
                return toCount(thread.contextMax) || 128000;
            }

            function estimateTokens(text) {
                if (!text) { return 0; }
                return Math.ceil(text.length / 4);
            }

            /** Usage status line: tokens of the last run plus rough context fill percent. */
            function renderUsageIndicator(thread) {
                var totalTokens = toCount(thread.lastUsage && thread.lastUsage.totalTokens);
                if (!totalTokens) {
                    return '';
                }
                var max = getContextMax(thread);
                var pct = Math.min(100, Math.round((totalTokens / max) * 100));
                return '<span class="usage-indicator" title="Last run: ' + totalTokens + ' tokens (~' +
                    pct + '% of context)">' +
                    formatTokenCount(totalTokens) + ' tok · ' + pct + '%</span>';
            }

            function getThreadSpaceUsage(thread) {
                if (!thread) {
                    return 0;
                }

                var estimatedTokens = 0;
                var messages = Array.isArray(thread.messages) ? thread.messages : [];
                for (var i = 0; i < messages.length; i++) {
                    var message = messages[i];
                    if (!message || message.role === 'tool') {
                        continue;
                    }
                    estimatedTokens += estimateTokens(String(message.content || ''));
                }

                estimatedTokens += estimateTokens(String(thread.pendingAssistantText || ''));
                return Math.max(toCount(thread.contextTokens), estimatedTokens);
            }

            function updatePaneContextUsage(paneEl, thread) {
                if (!paneEl || !thread) {
                    return;
                }

                var ctxInfo = formatContextGauge(getThreadSpaceUsage(thread), getContextMax(thread));
                var fill = paneEl.querySelector('.context-bar-fill');
                if (fill) {
                    fill.className = 'context-bar-fill' + (ctxInfo.level ? ' ' + ctxInfo.level : '');
                    fill.style.width = ctxInfo.pct + '%';
                }

                var label = paneEl.querySelector('.context-label');
                if (label) {
                    label.textContent = ctxInfo.label;
                }

                var pill = paneEl.querySelector('.pane-context');
                if (pill) {
                    pill.setAttribute('title', 'Context: ' + ctxInfo.label);
                }
            }

${TOOL_STATUS_JS}
            function getToolGroupKey(entries, messageIndex) {
                var first = entries[0] || {};
                return messageIndex + ':' + String(first.id || first.title || '');
            }

            /** A user's expand/collapse survives re-renders until the group's default catches up with it. */
            function rememberToolGroupOpen(threadId, key, isOpen, defaultOpen) {
                var overrides = toolGroupOpen[threadId] || (toolGroupOpen[threadId] = Object.create(null));
                if (isOpen === defaultOpen) {
                    delete overrides[key];
                } else {
                    overrides[key] = isOpen;
                }
            }

            function renderToolMessage(message, threadId, messageIndex) {
                var node = document.createElement('details');
                var entries = Array.isArray(message.entries) ? message.entries : [];
                var status = getToolGroupStatus(entries);
                var key = getToolGroupKey(entries, messageIndex);
                var overrides = toolGroupOpen[threadId] || {};
                var defaultOpen = shouldOpenToolGroup(status);
                node.className = 'message-tool';
                node.setAttribute('data-tool-key', key);
                node.setAttribute('data-default-open', String(defaultOpen));
                node.open = key in overrides ? overrides[key] : defaultOpen;

                var summary = document.createElement('summary');
                var summaryLine = document.createElement('span');
                summaryLine.className = 'message-tool-summary';
                var chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                chevron.setAttribute('class', 'message-tool-chevron');
                chevron.setAttribute('viewBox', '0 0 16 16');
                chevron.setAttribute('fill', 'currentColor');
                var chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                chevronPath.setAttribute('d', 'M6 4l4 4-4 4');
                chevronPath.setAttribute('stroke', 'currentColor');
                chevronPath.setAttribute('stroke-width', '1.5');
                chevronPath.setAttribute('fill', 'none');
                chevronPath.setAttribute('stroke-linecap', 'round');
                chevronPath.setAttribute('stroke-linejoin', 'round');
                chevron.appendChild(chevronPath);
                var icon = document.createElement('span');
                icon.className = 'message-tool-icon';
                icon.innerHTML = '&#9881;';
                var label = document.createElement('span');
                label.className = 'message-tool-label';
                label.textContent = 'Tools';
                var count = document.createElement('span');
                count.className = 'message-tool-count';
                count.textContent = '(' + entries.length + ')';
                summaryLine.appendChild(chevron);
                summaryLine.appendChild(icon);
                summaryLine.appendChild(label);
                summaryLine.appendChild(count);
                var statusEl = document.createElement('span');
                statusEl.className = 'message-tool-status' + getToolStatusClass(status);
                statusEl.textContent = getToolStatusSymbol(status) + ' ' + status;
                summary.appendChild(summaryLine);
                summary.appendChild(statusEl);
                node.appendChild(summary);

                var toolBody = document.createElement('div');
                toolBody.className = 'message-tool-body';

                entries.forEach(function(entry) {
                    var item = document.createElement('div');
                    item.className = 'message-tool-entry';
                    var header = document.createElement('div');
                    header.className = 'message-tool-entry-header';
                    var title = document.createElement('span');
                    title.className = 'message-tool-entry-title';
                    title.textContent = entry.title || 'tool';
                    var entryStatus = document.createElement('span');
                    entryStatus.className = 'message-tool-entry-status' + getToolStatusClass(entry.status || '');
                    entryStatus.textContent = getToolStatusSymbol(entry.status || '') + ' ' + (entry.status || '');
                    header.appendChild(title);
                    header.appendChild(entryStatus);
                    var details = document.createElement('pre');
                    details.className = 'message-tool-details';
                    setLinkifiedText(details, entry.details);
                    item.appendChild(header);
                    item.appendChild(details);
                    toolBody.appendChild(item);
                });

                node.appendChild(toolBody);
                return node;
            }

            function getSlashQuery(value) {
                if (!value || value.charAt(0) !== '/') {
                    return null;
                }
                var spaceIndex = value.indexOf(' ');
                if (spaceIndex === -1) {
                    return value.substring(1);
                }
                return null;
            }

            function filterSlashCommands(query) {
                var lower = (query || '').toLowerCase();
                return slashCommands.filter(function(command) {
                    return command.name.indexOf(lower) === 0;
                });
            }

            function getActiveSlashCommands(threadId) {
                if (composerUi.threadId !== threadId || composerUi.dropdown !== 'slash') {
                    return [];
                }
                var query = getSlashQuery(getDraft(threadId));
                if (query === null) {
                    return [];
                }
                return filterSlashCommands(query);
            }

            function renderSlashHint(threadId) {
                var commands = getActiveSlashCommands(threadId);
                if (!commands.length) {
                    return '<div class="slash-hint"></div>';
                }
                var activeIndex = Math.max(0, Math.min(composerUi.activeSlashIndex, commands.length - 1));
                var command = commands[activeIndex];
                return '<div class="slash-hint visible">/' + escapeHtml(command.name) + ' - ' +
                    escapeHtml(command.description) + '</div>';
            }

            function renderSlashDropdown(threadId) {
                var threadAttr = escapeAttr(threadId);
                var commands = getActiveSlashCommands(threadId);
                var visible = commands.length > 0;
                var activeIndex = Math.max(0, Math.min(composerUi.activeSlashIndex, commands.length - 1));
                var html = commands.map(function(command, index) {
                    return '<div class="slash-item' + (index === activeIndex ? ' active' : '') + '"' +
                        ' data-action="pick-slash" data-thread-id="' + threadAttr + '"' +
                        ' data-command="' + escapeAttr(command.name) + '">' +
                        '<div>' + escapeHtml(command.icon) + '</div>' +
                        '<div class="slash-info">' +
                            '<div class="slash-name">/' + escapeHtml(command.name) + '</div>' +
                            '<div class="slash-desc">' + escapeHtml(command.description) + '</div>' +
                        '</div>' +
                    '</div>';
                }).join('');
                return '<div class="slash-dropdown' + (visible ? ' visible' : '') + '">' + html + '</div>';
            }

            function renderFileDropdown(threadId) {
                var threadAttr = escapeAttr(threadId);
                var visible = composerUi.threadId === threadId &&
                    composerUi.dropdown === 'file' &&
                    composerUi.fileResults.length > 0;
                var activeIndex = Math.max(0, Math.min(composerUi.activeFileIndex, composerUi.fileResults.length - 1));
                var html = composerUi.fileResults.map(function(file, index) {
                    return '<div class="file-item' + (index === activeIndex ? ' active' : '') + '"' +
                        ' data-action="pick-file" data-thread-id="' + threadAttr + '"' +
                        ' data-path="' + escapeAttr(file.path) + '">' +
                        '<span class="file-item-name">' + escapeHtml(file.name) + '</span>' +
                        '<span class="file-item-path">' + escapeHtml(file.relativePath) + '</span>' +
                    '</div>';
                }).join('');
                return '<div class="file-dropdown' + (visible ? ' visible' : '') + '">' + html + '</div>';
            }

            function formatModelLabel(model) {
                return String(model || 'codex').toUpperCase();
            }

            function renderChatTypeDropdown(thread) {
                var threadAttr = escapeAttr(thread.id);
                var visible = composerUi.threadId === thread.id && composerUi.dropdown === 'chatType';
                var html = chatTypes.map(function(chatType) {
                    var selected = chatType.id === thread.currentChatType;
                    return '<div class="selector-item' + (selected ? ' selected' : '') + '"' +
                        ' role="option" tabindex="-1" aria-selected="' + selected + '"' +
                        ' data-action="select-chat-type" data-thread-id="' + threadAttr + '"' +
                        ' data-value="' + escapeAttr(chatType.id) + '">' +
                        '<span class="selector-item-label">' + escapeHtml(chatType.label) + '</span>' +
                        '<span class="selector-item-check">&#x2713;</span>' +
                    '</div>';
                }).join('');
                return '<div class="selector-dropdown' + (visible ? ' visible' : '') + '" role="listbox" aria-label="Chat type">' + html + '</div>';
            }

            function renderModelDropdown(thread) {
                var threadAttr = escapeAttr(thread.id);
                var visible = composerUi.threadId === thread.id && composerUi.dropdown === 'model';
                var models = availableModels.slice();
                if (composerUi.modelQuery) {
                    models = models.filter(function(model) {
                        return model.toLowerCase().indexOf(composerUi.modelQuery.toLowerCase()) !== -1;
                    });
                }
                var items = models.map(function(model) {
                    var selected = model === thread.currentModel;
                    return '<div class="selector-item' + (selected ? ' selected' : '') + '"' +
                        ' role="option" tabindex="-1" aria-selected="' + selected + '"' +
                        ' data-action="select-model" data-thread-id="' + threadAttr + '"' +
                        ' data-value="' + escapeAttr(model) + '">' +
                        '<span class="selector-item-label">' + escapeHtml(formatModelLabel(model)) + '</span>' +
                        '<span class="selector-item-check">&#x2713;</span>' +
                    '</div>';
                }).join('');
                return '<div class="selector-dropdown' + (visible ? ' visible' : '') + '">' +
                    '<input class="selector-search" data-thread-id="' + threadAttr + '"' +
                        ' aria-label="Search models" placeholder="Search models" value="' + escapeAttr(composerUi.modelQuery) + '">' +
                    '<div role="listbox" aria-label="Model">' + items + '</div>' +
                '</div>';
            }

            function getFileIcon(name, type) {
                if (type === 'image') { return '\u{1F5BC}\uFE0F'; }
                var ext = (String(name || '').split('.').pop() || '').toLowerCase();
                switch (ext) {
                    case 'ts': case 'tsx': return '\u{1F4D8}';
                    case 'js': case 'jsx': case 'mjs': case 'cjs': return '\u{1F4D2}';
                    case 'py': return '\u{1F40D}';
                    case 'md': case 'mdx': return '\u{1F4DD}';
                    case 'json': case 'yaml': case 'yml': case 'toml': return '\u{1F4CB}';
                    case 'css': case 'scss': case 'less': return '\u{1F3A8}';
                    case 'html': case 'htm': case 'vue': case 'svelte': return '\u{1F310}';
                    case 'sh': case 'bash': case 'zsh': return '\u{1F4DF}';
                    case 'sql': return '\u{1F5C3}\uFE0F';
                    case 'rs': return '\u{2699}\uFE0F';
                    case 'go': return '\u{1F439}';
                    default: return '\u{1F4C4}';
                }
            }

            function renderAttachments(thread) {
                var threadAttr = escapeAttr(thread.id);
                var atts = thread.pendingAttachments || [];
                if (!atts.length) { return ''; }
                var pills = atts.map(function(file, index) {
                    var icon = getFileIcon(file.name, file.type);
                    var visual = (file.type === 'image' && file.previewUri)
                        ? '<img class="att-pill-thumb" src="' + escapeAttr(file.previewUri) + '" alt="' + escapeAttr(file.name) + '">'
                        : '<span class="att-pill-icon">' + icon + '</span>';
                    return '<span class="att-pill' + (file.type === 'image' ? ' att-image' : '') + '">' +
                        visual +
                        '<span class="att-pill-name" title="' + escapeAttr(file.path) + '">' +
                            escapeHtml(file.name) +
                        '</span>' +
                        '<button class="att-pill-remove" data-action="remove-attachment"' +
                            ' aria-label="Remove ' + escapeAttr(file.name) + '" title="Remove ' + escapeAttr(file.name) + '"' +
                            ' data-thread-id="' + threadAttr + '" data-index="' + index + '">&#x00d7;</button>' +
                    '</span>';
                }).join('');
                var imageCount = atts.filter(function(a) { return a.type === 'image'; }).length;
                var fileCount = atts.length - imageCount;
                var summary = '<span class="att-count">';
                if (fileCount > 0) { summary += fileCount + ' file' + (fileCount > 1 ? 's' : ''); }
                if (fileCount > 0 && imageCount > 0) { summary += ', '; }
                if (imageCount > 0) { summary += imageCount + ' image' + (imageCount > 1 ? 's' : ''); }
                summary += '</span>';
                return pills + summary;
            }

            var recOpen = Object.create(null);

            function showsRecommendations(thread) {
                return Boolean(thread && recommendations.length > 0 &&
                    (thread.messages || []).length === 0 && !thread.pendingAssistantText);
            }

            function renderComposerRecommendations(thread) {
                if (!showsRecommendations(thread)) {
                    return '<div class="composer-recommendations hidden"></div>';
                }

                var isOpen = !!recOpen[thread.id];
                var threadAttr = escapeAttr(thread.id);
                return '<div class="composer-recommendations">' +
                    '<button class="rec-toggle' + (isOpen ? ' open' : '') + '" data-action="toggle-recs" data-thread-id="' + threadAttr + '">' +
                        '<span class="rec-caret">&#x25B6;</span> suggestions' +
                    '</button>' +
                    '<div class="recommendations' + (isOpen ? ' open' : '') + '">' +
                        recommendations.map(function(rec) {
                            return '<button class="rec-chip" data-action="use-recommendation"' +
                                ' data-thread-id="' + threadAttr + '" data-command="' + escapeAttr(rec.command) + '">' +
                                escapeHtml(rec.icon + ' ' + rec.label) +
                            '</button>';
                        }).join('') +
                    '</div>' +
                '</div>';
            }

            function renderComposer(thread) {
                var threadAttr = escapeAttr(thread.id);
                var chatType = chatTypes.find(function(item) { return item.id === thread.currentChatType; });
                var draft = getDraft(thread.id);
                var placeholder = 'Ask this thread anything...  / commands  @ files';

                return '<div class="composer-shell" data-thread-id="' + threadAttr + '">' +
                    renderFileDropdown(thread.id) +
                    renderSlashDropdown(thread.id) +
                    renderChatTypeDropdown(thread) +
                    renderModelDropdown(thread) +
                    '<div class="composer-card' + (composerUi.dragThreadId === thread.id ? ' drag-active' : '') + '" data-thread-id="' + threadAttr + '">' +
                        '<div class="drop-overlay' + (composerUi.dragThreadId === thread.id ? ' visible' : '') + '">' +
                            '<span class="drop-overlay-icon">\u{1F4CE}</span>' +
                            '<span class="drop-overlay-label">Drop files or images to attach</span>' +
                        '</div>' +
                        '<div class="composer-top">' +
                            '<div class="composer-target"><span>Thread</span><strong>' +
                                escapeHtml(thread.title) +
                            '</strong><span>#' + escapeHtml(String(thread.index)) + '</span></div>' +
                            '<div class="composer-top-spacer"></div>' +
                            '<button class="dropdown-trigger" data-action="toggle-chat-type" data-thread-id="' +
                                threadAttr + '" title="Chat type" aria-haspopup="listbox"' +
                                ' aria-expanded="' + (composerUi.threadId === thread.id && composerUi.dropdown === 'chatType') + '">' +
                                '<span>' + escapeHtml(chatType ? chatType.label : 'Chat') + '</span>' +
                                '<span>&#x25BE;</span>' +
                            '</button>' +
                            '<button class="dropdown-trigger" data-action="toggle-model" data-thread-id="' +
                                threadAttr + '" title="Model" aria-haspopup="listbox"' +
                                ' aria-expanded="' + (composerUi.threadId === thread.id && composerUi.dropdown === 'model') + '">' +
                                '<span>' + escapeHtml(formatModelLabel(thread.currentModel)) + '</span>' +
                                '<span>&#x25BE;</span>' +
                            '</button>' +
                        '</div>' +
                        '<textarea class="composer-input" data-thread-id="' + threadAttr + '"' +
                            ' rows="1" placeholder="' + escapeAttr(placeholder) + '"></textarea>' +
                        renderSlashHint(thread.id) +
                        '<div class="attachments">' + renderAttachments(thread) + '</div>' +
                        renderComposerRecommendations(thread) +
                        '<div class="composer-footer">' +
                            '<button class="btn-attach" data-action="attach" data-thread-id="' + threadAttr +
                                '" title="Attach file">+</button>' +
                            '<span class="composer-status">' + escapeHtml(getThreadStatusDetail(thread)) + '</span>' +
                            (function() {
                                var est = estimateTokens(draft);
                                var hasVal = est > 0;
                                return '<span class="composer-token-est' + (hasVal ? ' has-value' : '') + '">' +
                                    (hasVal ? '~' + formatTokenCount(est) + ' tokens' : '') +
                                '</span>' +
                                renderUsageIndicator(thread);
                            })() +
                            (getQueue(thread.id).length ? '<span class="queued-indicator" title="Message queued">queued</span>' : '') +
                            '<button class="btn-send' + (thread.isStreaming ? ' streaming' : '') + '"' +
                                ' data-action="' + (thread.isStreaming ? 'cancel' : 'send') + '"' +
                                ' data-thread-id="' + threadAttr + '"' +
                                ' title="' + (thread.isStreaming ? 'Stop' : 'Send') + '">' +
                                (thread.isStreaming ? '&#x25A0;' : '&#x2191;') +
                            '</button>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            }

            function shouldCollapseThread(thread) {
                // Only collapse in 1x1 with multiple threads
                if (currentDimension !== '1x1' || state.threads.length <= 1) {
                    return false;
                }
                // Manual override takes precedence
                if (thread.id in collapseOverrides) {
                    return collapseOverrides[thread.id];
                }
                // Active thread is never auto-collapsed
                if (thread.id === state.activeThreadId) {
                    return false;
                }
                // Auto-collapse if setting enabled and thread is completed/idle (not running)
                if (collapseCompleted && !thread.isStreaming && (thread.status === 'complete' || thread.status === 'error' || thread.status === 'cancelled')) {
                    return true;
                }
                return false;
            }

            function getOrderedThreads() {
                var threads = Array.isArray(state.threads) ? state.threads : [];
                if (threads.length <= 1) {
                    return threads;
                }

                var expandedThreads = [];
                var collapsedThreads = [];
                threads.forEach(function(thread) {
                    if (shouldCollapseThread(thread)) {
                        collapsedThreads.push(thread);
                    } else {
                        expandedThreads.push(thread);
                    }
                });

                return expandedThreads.concat(collapsedThreads);
            }

            function renderPaneHeader(thread, isCollapsed) {
                var threadAttr = escapeAttr(thread.id);
                var statusClass = String(thread.status || 'idle').toLowerCase();
                var sourceClass = String(thread.source || 'API').toLowerCase().replace(/[^a-z]/g, '');
                var ctxInfo = formatContextGauge(getThreadSpaceUsage(thread), getContextMax(thread));
                return '<div class="pane-header">' +
                        '<div class="pane-header-main">' +
                            '<div class="pane-title">' + escapeHtml(thread.title) + '</div>' +
                            '<div class="pane-meta">' +
                                '<span class="pane-pill">#' + escapeHtml(String(thread.index)) + '</span>' +
                                '<span class="pane-pill pane-source ' + sourceClass + '">' +
                                    escapeHtml(thread.source || 'API') +
                                '</span>' +
                                '<span class="pane-pill">' + escapeHtml(formatModelLabel(thread.currentModel)) + '</span>' +
                                '<span class="pane-pill">' + escapeHtml(thread.currentChatType || 'chat') + '</span>' +
                                '<span class="pane-pill pane-context" title="Context: ' + ctxInfo.label + '">' +
                                    '<span class="context-bar">' +
                                        '<span class="context-bar-fill ' + ctxInfo.level + '"></span>' +
                                    '</span>' +
                                    '<span class="context-label">' + ctxInfo.label + '</span>' +
                                '</span>' +
                                '<span class="pane-pill pane-status ' + escapeAttr(statusClass) + '">' +
                                    escapeHtml(getThreadStatusLabel(thread)) +
                                '</span>' +
                            '</div>' +
                        '</div>' +
                        '<div class="pane-actions">' +
                            (currentDimension === '1x1' && state.threads.length > 1
                                ? '<button class="pane-collapse-btn" data-action="toggleCollapse" data-thread-id="' + threadAttr + '" title="' + (isCollapsed ? 'Expand' : 'Collapse') + '">' + (isCollapsed ? '&#x25B6;' : '&#x25BC;') + '</button>'
                                : '') +
                            '<button class="pane-btn" data-action="sessions" data-thread-id="' + threadAttr + '">Sessions</button>' +
                            '<button class="pane-btn" data-action="export" data-thread-id="' + threadAttr + '">Export</button>' +
                            '<button class="pane-btn" data-action="clear" data-thread-id="' + threadAttr + '">Clear</button>' +
                            (state.threads.length > 1
                                ? '<button class="pane-btn" data-action="close" data-thread-id="' + threadAttr + '">Close</button>'
                                : '') +
                        '</div>' +
                    '</div>';
            }

            function isHiddenToolGroup(message) {
                if (message.role !== 'tool' || !hideToolActivity) {
                    return false;
                }
                var status = getToolGroupStatus(Array.isArray(message.entries) ? message.entries : []);
                return status === 'done' || status === 'cancelled';
            }

            function renderMessage(message, threadId, messageIndex) {
                if (message.role === 'tool') {
                    return renderToolMessage(message, threadId, messageIndex);
                }
                var node = document.createElement('div');
                if (message.role === 'assistant') {
                    node.className = 'message message-assistant';
                    if (typeof message.html === 'string' && message.html) {
                        node.innerHTML = message.html;
                        removeUnsafeLinks(node);
                        linkifyElement(node);
                    } else {
                        setLinkifiedText(node, message.content);
                    }
                } else if (message.role === 'error') {
                    node.className = 'message message-error';
                    setLinkifiedText(node, message.content);
                } else {
                    node.className = 'message message-user';
                    node.textContent = message.content || '';
                }
                return node;
            }

            function renderPaneBody(thread) {
                var body = document.createElement('div');
                body.className = 'pane-body';
                var messages = thread.messages || [];
                if (messages.length === 0 && !thread.pendingAssistantText) {
                    var empty = document.createElement('div');
                    empty.className = 'pane-empty';
                    empty.innerHTML =
                        '<div class="empty-detail">' +
                            '<div>' + escapeHtml(thread.notice || 'Empty thread. Start from the composer in this panel.') + '</div>' +
                        '</div>';
                    body.appendChild(empty);
                } else {
                    messages.forEach(function(message, messageIndex) {
                        if (!isHiddenToolGroup(message)) {
                            body.appendChild(renderMessage(message, thread.id, messageIndex));
                        }
                    });
                    if (thread.pendingAssistantText) {
                        var pending = document.createElement('div');
                        pending.className = 'message message-assistant message-pending';
                        pending.setAttribute('data-thread-id', thread.id);
                        // Streaming text is linkified once it lands as a message, not on every chunk.
                        pending.textContent = thread.pendingAssistantText;
                        body.appendChild(pending);
                    }
                    (thread.runNotices || []).forEach(function(text) {
                        var notice = document.createElement('div');
                        notice.className = 'message message-notice';
                        notice.setAttribute('role', 'status');
                        notice.textContent = text;
                        body.appendChild(notice);
                    });
                }
                body.addEventListener('scroll', function() {
                    userScrolledUp[thread.id] = !isNearBottom(body);
                });
                return body;
            }

            function htmlToElement(html) {
                var template = document.createElement('template');
                template.innerHTML = html;
                return template.content.firstElementChild;
            }

            function childWithClass(parent, className) {
                for (var i = 0; i < parent.children.length; i++) {
                    if (parent.children[i].classList.contains(className)) {
                        return parent.children[i];
                    }
                }
                return null;
            }

            function replaceIfChanged(live, fresh) {
                if (live.outerHTML !== fresh.outerHTML) {
                    live.replaceWith(fresh);
                }
            }

            /** Swaps only the composer parts whose markup changed; the textarea itself is never replaced. */
            function patchComposerShell(liveShell, freshShell) {
                var liveParts = Array.from(liveShell.children);
                Array.from(freshShell.children).forEach(function(freshPart, index) {
                    var livePart = liveParts[index];
                    if (!freshPart.classList.contains('composer-card')) {
                        replaceIfChanged(livePart, freshPart);
                        return;
                    }
                    livePart.className = freshPart.className;
                    var liveCardParts = Array.from(livePart.children);
                    Array.from(freshPart.children).forEach(function(freshCardPart, cardIndex) {
                        if (!freshCardPart.classList.contains('composer-input')) {
                            replaceIfChanged(liveCardParts[cardIndex], freshCardPart);
                        }
                    });
                });
            }

            /** Host snapshots carry new arrays; a reference hit skips the serialisation on local re-renders. */
            function isBodyCurrent(cache, thread) {
                if (cache.pending !== (thread.pendingAssistantText || '') || cache.notice !== (thread.notice || '') ||
                    cache.runNotices !== JSON.stringify(thread.runNotices || []) || cache.hideToolActivity !== hideToolActivity) {
                    return false;
                }
                if (cache.messagesRef === thread.messages) {
                    return true;
                }
                var json = JSON.stringify(thread.messages || []);
                cache.messagesRef = thread.messages;
                return json === cache.messagesJson;
            }

            function rememberBody(cache, thread) {
                cache.pending = thread.pendingAssistantText || '';
                cache.notice = thread.notice || '';
                cache.runNotices = JSON.stringify(thread.runNotices || []);
                cache.hideToolActivity = hideToolActivity;
                cache.messagesRef = thread.messages;
                cache.messagesJson = JSON.stringify(thread.messages || []);
            }

            function syncPaneBody(pane, cache, thread) {
                var liveBody = childWithClass(pane, 'pane-body');
                if (liveBody && isBodyCurrent(cache, thread)) {
                    return;
                }
                var body = renderPaneBody(thread);
                var savedScroll = liveBody ? liveBody.scrollTop : null;
                if (liveBody) {
                    liveBody.replaceWith(body);
                } else {
                    pane.appendChild(body);
                }
                rememberBody(cache, thread);
                if (userScrolledUp[thread.id] && savedScroll !== null) {
                    body.scrollTop = savedScroll;
                } else {
                    setTimeout(function() { scrollPaneToBottom(body, thread.id); }, 0);
                }
            }

            function syncComposer(pane, thread) {
                var freshShell = htmlToElement(renderComposer(thread));
                var liveShell = childWithClass(pane, 'composer-shell');
                if (liveShell) {
                    patchComposerShell(liveShell, freshShell);
                } else {
                    pane.appendChild(freshShell);
                    liveShell = freshShell;
                }
                // Set as a property: markup would drop a leading newline, and rewriting an equal value would cost native undo.
                var textarea = liveShell.querySelector('.composer-input');
                var draft = getDraft(thread.id);
                if (textarea.value !== draft) {
                    textarea.value = draft;
                }
                setTimeout(function() { autoResizeTextarea(textarea); }, 0);
            }

            /** Updates a pane in place, rebuilding only the header, transcript or composer parts whose data changed. */
            function syncPane(pane, thread) {
                var cache = paneCache[thread.id] || (paneCache[thread.id] = {});
                var isCollapsed = shouldCollapseThread(thread);
                pane.className = 'pane' +
                    (thread.id === state.activeThreadId ? ' active' : '') +
                    (isCollapsed ? ' collapsed' : '');
                var headerHtml = renderPaneHeader(thread, isCollapsed);
                var liveHeader = childWithClass(pane, 'pane-header');
                if (!liveHeader || cache.header !== headerHtml) {
                    var header = htmlToElement(headerHtml);
                    if (liveHeader) {
                        liveHeader.replaceWith(header);
                    } else {
                        pane.insertBefore(header, pane.firstChild);
                    }
                    cache.header = headerHtml;
                }
                syncPaneBody(pane, cache, thread);
                syncPanePrompts(pane, cache, thread);
                // CSP drops style attributes parsed from markup; CSSOM writes still apply.
                updatePaneContextUsage(pane, thread);
                syncComposer(pane, thread);
            }

            function pruneClosedThreadState() {
                var open = Object.create(null);
                state.threads.forEach(function(thread) { open[thread.id] = true; });
                [drafts, collapseOverrides, messageQueue, recOpen, userScrolledUp, toolGroupOpen, unconfirmedSends, paneCache].forEach(function(byThread) {
                    Object.keys(byThread).forEach(function(threadId) {
                        if (!open[threadId]) {
                            delete byThread[threadId];
                        }
                    });
                });
                prunePromptDrafts(state.threads);
            }

            function removeStalePanes() {
                Array.from(paneGrid.children).forEach(function(child) {
                    var isLivePane = child.classList.contains('pane') && getThreadById(child.getAttribute('data-thread-id'));
                    if (!isLivePane && !child.classList.contains('openclaw-crash')) {
                        child.remove();
                    }
                });
            }

            function renderState(preserve) {
                // Touching the DOM mid-composition aborts the IME; compositionend flushes.
                if (composing) {
                    renderDeferred = true;
                    return;
                }
                pruneClosedThreadState();
                var orderedThreads = getOrderedThreads();
                if (orderedThreads.length === 0) {
                    paneGrid.innerHTML = '<div class="pane-empty"><div class="empty-detail">No threads available.</div></div>';
                    return;
                }
                removeStalePanes();

                orderedThreads.forEach(function(thread, index) {
                    try {
                        var pane = findThreadElement('.pane', thread.id);
                        if (!pane) {
                            pane = document.createElement('section');
                            pane.dataset.threadId = thread.id;
                        }
                        syncPane(pane, thread);
                        if (paneGrid.children[index] !== pane) {
                            paneGrid.insertBefore(pane, paneGrid.children[index] || null);
                        }
                    } catch (e) {
                        _showCrash('Render failed for thread #' + (thread.index || '?') + ' (' + thread.id + ')', e);
                    }
                });

                var restore = preserve || {};
                if (restore.threadId) {
                    try {
                        var field = findThreadElement(restore.selector || '.composer-input', restore.threadId);
                        if (field) {
                            if (document.activeElement !== field) {
                                field.focus();
                            }
                            if (typeof restore.selectionStart === 'number' && typeof restore.selectionEnd === 'number' &&
                                (field.selectionStart !== restore.selectionStart || field.selectionEnd !== restore.selectionEnd)) {
                                field.setSelectionRange(restore.selectionStart, restore.selectionEnd);
                            }
                        }
                    } catch (e) {
                        console.warn('[OpenClaw] focus restore failed:', e);
                    }
                }

                try {
                    scrollActiveComposerOptionIntoView();
                } catch (e) {
                    console.warn('[OpenClaw] dropdown scroll sync failed:', e);
                }
            }

            function scrollActiveComposerOptionIntoView() {
                if (!composerUi.threadId || !composerUi.dropdown) {
                    return;
                }

                var shell = findThreadElement('.composer-shell', composerUi.threadId);
                if (!shell) {
                    return;
                }

                var dropdownSelector = '';
                var activeSelector = '';
                if (composerUi.dropdown === 'slash') {
                    dropdownSelector = '.slash-dropdown.visible';
                    activeSelector = '.slash-item.active';
                } else if (composerUi.dropdown === 'file') {
                    dropdownSelector = '.file-dropdown.visible';
                    activeSelector = '.file-item.active';
                } else {
                    return;
                }

                var dropdown = shell.querySelector(dropdownSelector);
                var activeItem = dropdown ? dropdown.querySelector(activeSelector) : null;
                if (activeItem && typeof activeItem.scrollIntoView === 'function') {
                    activeItem.scrollIntoView({ block: 'nearest' });
                }
            }

            var COMPOSER_FIELDS = ['.composer-input', '.selector-search'];

            /** The focused composer text field, so a re-render can hand focus and caret back to its replacement. */
            function captureComposerFocus() {
                var active = document.activeElement;
                if (!active || typeof active.matches !== 'function') {
                    return null;
                }
                var selector = COMPOSER_FIELDS.find(function(candidate) { return active.matches(candidate); });
                if (!selector) {
                    return null;
                }
                return {
                    selector: selector,
                    threadId: active.getAttribute('data-thread-id'),
                    selectionStart: active.selectionStart,
                    selectionEnd: active.selectionEnd
                };
            }

            function setActiveThread(threadId) {
                if (!threadId || state.activeThreadId === threadId) {
                    return;
                }
                var focus = captureComposerFocus();
                state.activeThreadId = threadId;
                vscode.postMessage({ type: 'focusThread', threadId: threadId });
                renderState(focus);
            }

            function closeComposerDropdowns() {
                composerUi.dropdown = '';
                composerUi.threadId = '';
                composerUi.activeSlashIndex = 0;
                composerUi.activeFileIndex = 0;
                composerUi.modelQuery = '';
            }

            function clearAtMention() {
                composerUi.atMentionThreadId = '';
                composerUi.atMentionStart = -1;
                composerUi.fileResults = [];
                if (composerUi.fileSearchDebounce) {
                    clearTimeout(composerUi.fileSearchDebounce);
                    composerUi.fileSearchDebounce = null;
                }
                if (composerUi.dropdown === 'file') {
                    closeComposerDropdowns();
                }
            }

            function queueFileSearch(threadId, query) {
                if (composerUi.fileSearchDebounce) {
                    clearTimeout(composerUi.fileSearchDebounce);
                }
                // Results for the previous query must not stay selectable while this one debounces.
                if (composerUi.fileSearchQuery !== query) {
                    composerUi.fileResults = [];
                }
                composerUi.fileSearchQuery = query;
                composerUi.fileSearchDebounce = setTimeout(function() {
                    vscode.postMessage({ type: 'fileSearch', query: query, threadId: threadId });
                }, 120);
            }

            function checkAtMention(threadId, textarea) {
                var cursor = textarea.selectionStart;
                var text = textarea.value;
                var atPos = -1;

                for (var i = cursor - 1; i >= 0; i--) {
                    if (text[i] === '@') {
                        if (i === 0 || /\\s/.test(text[i - 1])) {
                            atPos = i;
                        }
                        break;
                    }
                    if (/\\s/.test(text[i])) {
                        break;
                    }
                }

                if (atPos < 0) {
                    clearAtMention();
                    return;
                }

                composerUi.threadId = threadId;
                composerUi.dropdown = 'file';
                composerUi.activeFileIndex = 0;
                composerUi.atMentionThreadId = threadId;
                composerUi.atMentionStart = atPos;
                queueFileSearch(threadId, text.substring(atPos + 1, cursor));
            }

            function updateSlashState(threadId) {
                var query = getSlashQuery(getDraft(threadId));
                if (query === null) {
                    if (composerUi.dropdown === 'slash' && composerUi.threadId === threadId) {
                        closeComposerDropdowns();
                    }
                    return;
                }

                var commands = filterSlashCommands(query);
                if (!commands.length) {
                    if (composerUi.dropdown === 'slash' && composerUi.threadId === threadId) {
                        closeComposerDropdowns();
                    }
                    return;
                }

                composerUi.threadId = threadId;
                composerUi.dropdown = 'slash';
                composerUi.activeSlashIndex = Math.max(0, Math.min(composerUi.activeSlashIndex, commands.length - 1));
            }

            function selectSlashCommand(threadId, commandName) {
                setDraft(threadId, '/' + commandName + ' ');
                composerUi.threadId = threadId;
                composerUi.dropdown = 'slash';
                composerUi.activeSlashIndex = 0;
                renderState({
                    threadId: threadId,
                    selectionStart: getDraft(threadId).length,
                    selectionEnd: getDraft(threadId).length
                });
            }

            function selectFileFromDropdown(threadId, filePath, textarea) {
                var text = getDraft(threadId);
                var cursor = textarea ? textarea.selectionStart : text.length;
                var before = text.substring(0, composerUi.atMentionStart);
                var after = text.substring(cursor);
                var nextValue = before + after;
                setDraft(threadId, nextValue);
                clearAtMention();
                vscode.postMessage({ type: 'attachFile', threadId: threadId, filePath: filePath });
                renderState({
                    threadId: threadId,
                    selectionStart: before.length,
                    selectionEnd: before.length
                });
            }

            /** Held per send until the host accepts or rejects it by clientId, so a rejection can give the text back. */
            function rememberUnconfirmedSend(threadId, text) {
                sendCounter += 1;
                var clientId = 'send-' + sendCounter;
                (unconfirmedSends[threadId] = unconfirmedSends[threadId] || []).push({ clientId: clientId, text: text });
                return clientId;
            }

            function takeUnconfirmedSend(threadId, clientId) {
                var pending = unconfirmedSends[threadId] || [];
                var index = pending.findIndex(function(entry) { return entry.clientId === clientId; });
                return index < 0 ? null : pending.splice(index, 1)[0];
            }

            /** Put text back in front of the draft, e.g. a rejected send or a queued message the user stopped. */
            function restoreToDraft(threadId, text) {
                var current = getDraft(threadId);
                setDraft(threadId, current ? text + '\\n\\n' + current : text);
            }

            function restoreRejectedSend(threadId, clientId) {
                var pending = takeUnconfirmedSend(threadId, clientId);
                if (!pending || !getThreadById(threadId)) {
                    return;
                }
                restoreToDraft(threadId, pending.text);
                renderState(captureComposerFocus());
            }

            function getQueue(threadId) {
                return messageQueue[threadId] || [];
            }

            /** Stop and Clear must not send the queued drafts once the thread goes idle: they return to the composer. */
            function restoreQueuedMessage(threadId) {
                var queued = getQueue(threadId);
                if (!queued.length) {
                    return;
                }
                delete messageQueue[threadId];
                restoreToDraft(threadId, queued.join('\\n\\n'));
                renderState(captureComposerFocus());
            }

            function dispatchText(thread, text) {
                var clientId = rememberUnconfirmedSend(thread.id, text);
                var match = text.match(/^\\/([a-zA-Z]+)\\s*([\\s\\S]*)/);
                var command = match && slashCommands.find(function(item) { return item.name === match[1].toLowerCase(); });
                if (command) {
                    vscode.postMessage({ type: 'slashCommand', threadId: thread.id, command: command.name, text: match[2], clientId: clientId });
                } else {
                    vscode.postMessage({ type: 'send', threadId: thread.id, text: text, clientId: clientId });
                }
                userScrolledUp[thread.id] = false;
            }

            /** Sends the draft, or queues it behind the running reply; each queued draft goes out as its own turn. */
            function sendThread(threadId) {
                var thread = getThreadById(threadId);
                var raw = getDraft(threadId).trim();
                if (!thread || !raw) {
                    return;
                }
                if (thread.isStreaming) {
                    (messageQueue[threadId] = getQueue(threadId)).push(raw);
                } else {
                    dispatchText(thread, raw);
                }
                setDraft(threadId, '');
                clearAtMention();
                closeComposerDropdowns();
                renderState({ threadId: threadId, selectionStart: 0, selectionEnd: 0 });
            }

            /** One queued draft per idle turn, and only once the host has settled the previous send. */
            function drainQueuedMessages() {
                state.threads.forEach(function(thread) {
                    var queued = getQueue(thread.id);
                    if (thread.isStreaming || !queued.length || (unconfirmedSends[thread.id] || []).length) {
                        return;
                    }
                    var next = queued.shift();
                    if (!queued.length) {
                        delete messageQueue[thread.id];
                    }
                    dispatchText(thread, next);
                });
            }

            function toggleDropdown(threadId, kind) {
                if (composerUi.threadId === threadId && composerUi.dropdown === kind) {
                    closeComposerDropdowns();
                } else {
                    composerUi.threadId = threadId;
                    composerUi.dropdown = kind;
                    composerUi.modelQuery = '';
                    composerUi.activeSlashIndex = 0;
                    composerUi.activeFileIndex = 0;
                }
                renderState();
                focusOpenedSelector(threadId, kind);
            }

            /** Keyboard users land in the menu they opened: the model search, or the chosen chat type. */
            function focusOpenedSelector(threadId, kind) {
                if (composerUi.threadId !== threadId || composerUi.dropdown !== kind) {
                    return;
                }
                var shell = findThreadElement('.composer-shell', threadId);
                var dropdown = shell && shell.querySelector('.selector-dropdown.visible');
                if (!dropdown) {
                    return;
                }
                var target = dropdown.querySelector('.selector-search') ||
                    dropdown.querySelector('.selector-item.selected') || dropdown.querySelector('.selector-item');
                if (target) {
                    target.focus();
                }
            }

            /** Arrows walk a selector's options, Enter or Space picks; Enter in the search picks the first match. */
            function handleSelectorKeydown(event) {
                var dropdown = event.target.closest('.selector-dropdown');
                if (!dropdown) {
                    return false;
                }
                var options = Array.from(dropdown.querySelectorAll('.selector-item'));
                var option = event.target.closest('.selector-item');
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    if (options.length) {
                        var step = event.key === 'ArrowDown' ? 1 : -1;
                        var current = options.indexOf(option);
                        var next = current === -1 ? (step > 0 ? 0 : options.length - 1) : (current + step + options.length) % options.length;
                        options[next].focus();
                    }
                    return true;
                }
                var picksOption = event.key === 'Enter' || (event.key === ' ' && option);
                if (picksOption && (option || options[0])) {
                    event.preventDefault();
                    (option || options[0]).click();
                    return true;
                }
                return false;
            }

            btnNew.addEventListener('click', function() {
                vscode.postMessage({ type: 'newSession' });
            });

            btnSplit.addEventListener('click', function() {
                vscode.postMessage({ type: 'splitThread' });
            });

            if (btnPopout) {
                btnPopout.addEventListener('click', function() {
                    vscode.postMessage({ type: 'popOut' });
                });
            }

            function renderDimensionOptions() {
                dimensionSelect.innerHTML = '';
                gridDimensions.forEach(function(dimension) {
                    var option = document.createElement('option');
                    option.value = dimension;
                    option.textContent = dimension;
                    dimensionSelect.appendChild(option);
                });
                dimensionSelect.value = currentDimension;
            }

            function updateGridDimension(dimension) {
                var parts = dimension.split('x');
                var cols = parseInt(parts[0], 10) || 1;
                var rows = parseInt(parts[1], 10) || 1;
                paneGrid.style.setProperty('--grid-cols', cols);
                paneGrid.style.setProperty('--grid-rows', rows);
            }

            dimensionSelect.addEventListener('change', function() {
                currentDimension = dimensionSelect.value;
                updateGridDimension(currentDimension);
                vscode.postMessage({ type: 'setDimension', dimension: currentDimension });
                // Collapsing and its toggle exist only in 1x1.
                renderState(captureComposerFocus());
            });

            function openFileFromLink(fileLink) {
                if (!fileLink) {
                    return;
                }
                vscode.postMessage({
                    type: 'openFile',
                    filePath: fileLink.getAttribute('data-file-path'),
                    line: fileLink.getAttribute('data-line') || ''
                });
            }

            paneGrid.addEventListener('click', function(event) {
                var fileLink = event.target.closest('.file-link');
                if (fileLink) {
                    event.preventDefault();
                    event.stopPropagation();
                    openFileFromLink(fileLink);
                    return;
                }
            });

            paneGrid.addEventListener('keydown', function(event) {
                if (event.key !== 'Enter' && event.key !== ' ') {
                    return;
                }

                var fileLink = event.target.closest('.file-link');
                if (fileLink) {
                    event.preventDefault();
                    event.stopPropagation();
                    openFileFromLink(fileLink);
                }
            });

            paneGrid.addEventListener('click', function(event) {
                var actionEl = event.target.closest('[data-action]');
                var pane = event.target.closest('.pane');
                if (pane && !actionEl) {
                    var clickedId = pane.getAttribute('data-thread-id');
                    if (pane.classList.contains('collapsed')) {
                        collapseOverrides[clickedId] = false;
                    }
                    setActiveThread(clickedId);
                    return;
                }

                if (!actionEl) {
                    return;
                }

                var action = actionEl.getAttribute('data-action');
                var threadId = actionEl.getAttribute('data-thread-id');
                // Read before activating: the active thread is never auto-collapsed.
                var wasCollapsed = action === 'toggleCollapse' && shouldCollapseThread(getThreadById(threadId) || {});
                if (threadId) {
                    setActiveThread(threadId);
                }
                if (handlePromptAction(action, actionEl)) {
                    return;
                }

                if (action === 'toggleCollapse') {
                    collapseOverrides[threadId] = !wasCollapsed;
                    renderState(captureComposerFocus());
                    return;
                }
                if (action === 'sessions') {
                    requestSessionsPanel(threadId);
                    return;
                }
                if (action === 'clear') {
                    restoreQueuedMessage(threadId);
                    vscode.postMessage({ type: 'clearThread', threadId: threadId });
                    return;
                }
                if (action === 'close') {
                    vscode.postMessage({ type: 'closeThread', threadId: threadId });
                    return;
                }
                if (action === 'export') {
                    vscode.postMessage({ type: 'exportThread', threadId: threadId });
                    return;
                }
                if (action === 'attach') {
                    vscode.postMessage({ type: 'attach', threadId: threadId });
                    return;
                }
                if (action === 'send') {
                    sendThread(threadId);
                    return;
                }
                if (action === 'cancel') {
                    restoreQueuedMessage(threadId);
                    vscode.postMessage({ type: 'cancel', threadId: threadId });
                    return;
                }
                if (action === 'remove-attachment') {
                    vscode.postMessage({
                        type: 'removeAttachment',
                        threadId: threadId,
                        index: Number(actionEl.getAttribute('data-index'))
                    });
                    return;
                }
                if (action === 'toggle-chat-type') {
                    toggleDropdown(threadId, 'chatType');
                    return;
                }
                if (action === 'toggle-model') {
                    toggleDropdown(threadId, 'model');
                    return;
                }
                if (action === 'select-chat-type') {
                    closeComposerDropdowns();
                    vscode.postMessage({
                        type: 'setChatType',
                        threadId: threadId,
                        chatType: actionEl.getAttribute('data-value')
                    });
                    renderState({ threadId: threadId });
                    return;
                }
                if (action === 'select-model') {
                    closeComposerDropdowns();
                    vscode.postMessage({
                        type: 'setModel',
                        threadId: threadId,
                        model: actionEl.getAttribute('data-value')
                    });
                    renderState({ threadId: threadId });
                    return;
                }
                if (action === 'pick-slash') {
                    selectSlashCommand(threadId, actionEl.getAttribute('data-command'));
                    return;
                }
                if (action === 'pick-file') {
                    var textarea = findThreadElement('.composer-input', threadId);
                    selectFileFromDropdown(threadId, actionEl.getAttribute('data-path'), textarea);
                    return;
                }
                if (action === 'toggle-recs') {
                    recOpen[threadId] = !recOpen[threadId];
                    renderState(captureComposerFocus());
                    return;
                }
                if (action === 'use-recommendation') {
                    var command = actionEl.getAttribute('data-command') || '';
                    setDraft(threadId, command + ' ');
                    composerUi.threadId = threadId;
                    composerUi.dropdown = '';
                    renderState({
                        threadId: threadId,
                        selectionStart: getDraft(threadId).length,
                        selectionEnd: getDraft(threadId).length
                    });
                }
            });

            function renderKeepingCaret(threadId, textarea) {
                renderState({
                    threadId: threadId,
                    selectionStart: textarea.selectionStart,
                    selectionEnd: textarea.selectionEnd
                });
            }

            function handleComposerInput(textarea) {
                var threadId = textarea.getAttribute('data-thread-id');
                setDraft(threadId, textarea.value);
                composerUi.threadId = threadId;
                updateSlashState(threadId);
                checkAtMention(threadId, textarea);
                renderKeepingCaret(threadId, textarea);
            }

            paneGrid.addEventListener('change', function(event) {
                var choice = event.target.closest('.prompt-choice');
                if (choice) {
                    updatePromptDraft(choice);
                }
            });

            paneGrid.addEventListener('keydown', handlePromptKeydown);

            paneGrid.addEventListener('input', function(event) {
                var promptField = event.target.closest('.prompt-other');
                if (promptField) {
                    updatePromptDraft(promptField);
                    return;
                }
                var textarea = event.target.closest('.composer-input');
                if (textarea) {
                    cancelSessionsRequest();
                    // Replacing the textarea mid-composition would abort the IME; compositionend catches up.
                    if (event.isComposing || composing) {
                        setDraft(textarea.getAttribute('data-thread-id'), textarea.value);
                        return;
                    }
                    handleComposerInput(textarea);
                    return;
                }

                var search = event.target.closest('.selector-search');
                if (search) {
                    composerUi.threadId = search.getAttribute('data-thread-id');
                    composerUi.dropdown = 'model';
                    composerUi.modelQuery = search.value;
                    renderState({
                        selector: '.selector-search',
                        threadId: composerUi.threadId,
                        selectionStart: search.selectionStart,
                        selectionEnd: search.selectionEnd
                    });
                }
            });

            paneGrid.addEventListener('compositionstart', function() {
                composing = true;
            });

            function endComposition(textarea) {
                composing = false;
                renderDeferred = false;
                if (textarea) {
                    handleComposerInput(textarea);
                } else {
                    renderState(captureComposerFocus());
                }
            }

            paneGrid.addEventListener('compositionend', function(event) {
                endComposition(event.target.closest('.composer-input'));
            });

            // A composition abandoned by a focus change fires no compositionend in every engine.
            paneGrid.addEventListener('focusout', function() {
                if (composing) {
                    endComposition(null);
                }
            });

            paneGrid.addEventListener('keydown', function(event) {
                if (handleSelectorKeydown(event)) {
                    return;
                }
                if (event.key === 'Escape' && composerUi.dropdown && event.target.closest('.composer-shell')) {
                    event.preventDefault();
                    var focus = captureComposerFocus();
                    var restore = focus && focus.selector === '.composer-input' ? focus : { threadId: composerUi.threadId };
                    clearAtMention();
                    closeComposerDropdowns();
                    renderState(restore);
                    return;
                }

                var textarea = event.target.closest('.composer-input');
                if (!textarea || event.isComposing) {
                    return;
                }

                var threadId = textarea.getAttribute('data-thread-id');
                var fileVisible = composerUi.threadId === threadId && composerUi.dropdown === 'file' && composerUi.fileResults.length > 0;
                if (fileVisible) {
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        composerUi.activeFileIndex = Math.min(composerUi.activeFileIndex + 1, composerUi.fileResults.length - 1);
                        renderKeepingCaret(threadId, textarea);
                        return;
                    }
                    if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        composerUi.activeFileIndex = Math.max(composerUi.activeFileIndex - 1, 0);
                        renderKeepingCaret(threadId, textarea);
                        return;
                    }
                    if (event.key === 'Enter' || event.key === 'Tab') {
                        event.preventDefault();
                        selectFileFromDropdown(threadId, composerUi.fileResults[composerUi.activeFileIndex].path, textarea);
                        return;
                    }
                }

                var slashCommandsForThread = getActiveSlashCommands(threadId);
                if (slashCommandsForThread.length) {
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        composerUi.activeSlashIndex = Math.min(composerUi.activeSlashIndex + 1, slashCommandsForThread.length - 1);
                        renderKeepingCaret(threadId, textarea);
                        return;
                    }
                    if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        composerUi.activeSlashIndex = Math.max(composerUi.activeSlashIndex - 1, 0);
                        renderKeepingCaret(threadId, textarea);
                        return;
                    }
                    if (event.key === 'Enter' || event.key === 'Tab') {
                        event.preventDefault();
                        selectSlashCommand(threadId, slashCommandsForThread[composerUi.activeSlashIndex].name);
                        return;
                    }
                }

                if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                    event.preventDefault();
                    sendThread(threadId);
                    return;
                }
                var thread = getThreadById(threadId);
                if (event.key === 'Escape' && thread && thread.isStreaming) {
                    event.preventDefault();
                    restoreQueuedMessage(threadId);
                    vscode.postMessage({ type: 'cancel', threadId: threadId });
                }
            });

            paneGrid.addEventListener('focusin', function(event) {
                var textarea = event.target.closest('.composer-input');
                if (textarea) {
                    setActiveThread(textarea.getAttribute('data-thread-id'));
                }
            });

            paneGrid.addEventListener('dragenter', function(event) {
                var shell = event.target.closest('.composer-shell');
                if (!shell || !hasFileDrag(event.dataTransfer)) {
                    return;
                }
                event.preventDefault();
                var tid = shell.getAttribute('data-thread-id');
                // A re-render swaps the nodes under the pointer and fires another dragenter.
                if (composerUi.dragThreadId !== tid) {
                    composerUi.dragThreadId = tid;
                    renderState();
                }
            });

            paneGrid.addEventListener('dragover', function(event) {
                var shell = event.target.closest('.composer-shell');
                if (!shell || !hasFileDrag(event.dataTransfer)) {
                    return;
                }
                event.preventDefault();
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'copy';
                }
                var tid = shell.getAttribute('data-thread-id');
                if (composerUi.dragThreadId !== tid) {
                    composerUi.dragThreadId = tid;
                    renderState();
                }
            });

            paneGrid.addEventListener('dragleave', function(event) {
                var shell = event.target.closest('.composer-shell');
                if (!shell || !hasFileDrag(event.dataTransfer)) {
                    return;
                }
                if (!shell.contains(event.relatedTarget)) {
                    composerUi.dragThreadId = '';
                    renderState();
                }
            });

            paneGrid.addEventListener('drop', function(event) {
                var shell = event.target.closest('.composer-shell');
                if (!shell || !hasFileDrag(event.dataTransfer)) {
                    return;
                }
                event.preventDefault();
                var threadId = shell.getAttribute('data-thread-id');
                composerUi.dragThreadId = '';
                var filePaths = extractDroppedPaths(event.dataTransfer);
                if (filePaths.length) {
                    vscode.postMessage({
                        type: 'attachFiles',
                        threadId: threadId,
                        filePaths: filePaths
                    });
                }
                renderState();
            });

            paneGrid.addEventListener('toggle', function(event) {
                var group = event.target;
                var pane = group.classList.contains('message-tool') ? group.closest('.pane') : null;
                if (pane) {
                    rememberToolGroupOpen(
                        pane.getAttribute('data-thread-id'),
                        group.getAttribute('data-tool-key'),
                        group.open,
                        group.getAttribute('data-default-open') === 'true'
                    );
                }
            }, true);

            // Only when something is open: a needless re-render would drop the user's text selection.
            // The dispatch path, not target.closest: a re-render may already have detached the clicked node.
            function isInsideComposer(event) {
                return event.composedPath().some(function(node) {
                    return node.classList && node.classList.contains('composer-shell');
                });
            }

            document.addEventListener('click', function(event) {
                if (isInsideComposer(event) || (!composerUi.dropdown && !composerUi.atMentionThreadId)) {
                    return;
                }
                closeComposerDropdowns();
                clearAtMention();
                renderState(captureComposerFocus());
            });

            window.addEventListener('dragend', function() {
                if (composerUi.dragThreadId) {
                    composerUi.dragThreadId = '';
                    renderState();
                }
            });

            window.addEventListener('message', function(event) {
                var message;
                try { message = event.data; } catch (e) {
                    _showCrash('Failed to read message data', e);
                    return;
                }
                try { _handleMessage(message); } catch (e) {
                    _showCrash('Message handler crashed (type=' + (message && message.type) + ')', e);
                }
            });

            /** Streams a reply chunk into its pane without a full re-render. */
            function applyTextUpdate(threadId, text) {
                var thread = getThreadById(threadId);
                if (!thread) {
                    return;
                }
                thread.pendingAssistantText = text;
                thread.isStreaming = true;
                thread.status = 'running';

                var pane = findThreadElement('.pane', threadId);
                if (!pane) {
                    return;
                }
                var paneBody = pane.querySelector('.pane-body');
                var pending = pane.querySelector('.message-pending');
                if (!pending && paneBody) {
                    var empty = paneBody.querySelector('.pane-empty');
                    if (empty) { empty.remove(); }
                    pending = document.createElement('div');
                    pending.className = 'message message-assistant message-pending';
                    pending.setAttribute('data-thread-id', threadId);
                    paneBody.appendChild(pending);
                }
                if (pending) {
                    pending.textContent = text;
                }
                scrollPaneToBottom(paneBody, threadId);

                var statusPill = pane.querySelector('.pane-status');
                if (statusPill) {
                    statusPill.className = 'pane-pill pane-status running';
                    statusPill.textContent = getThreadStatusLabel(thread);
                }
                var sendBtn = pane.querySelector('.btn-send');
                if (sendBtn) {
                    sendBtn.classList.add('streaming');
                    sendBtn.setAttribute('data-action', 'cancel');
                    sendBtn.setAttribute('title', 'Stop');
                    sendBtn.textContent = '\u25A0';
                }
                var statusDetail = pane.querySelector('.composer-status');
                if (statusDetail) { statusDetail.textContent = getThreadStatusDetail(thread); }
                updatePaneContextUsage(pane, thread);
            }

            function _handleMessage(message) {
                if (message.type === 'slashCommands') {
                    slashCommands = Array.isArray(message.commands) ? message.commands : [];
                    return;
                }
                if (message.type === 'recommendations') {
                    // Pushed on every selection and diagnostics change: re-render only when a pane shows a difference.
                    var nextRecommendations = Array.isArray(message.items) ? message.items : [];
                    var changed = JSON.stringify(nextRecommendations) !== JSON.stringify(recommendations);
                    var wasShown = state.threads.some(showsRecommendations);
                    recommendations = nextRecommendations;
                    if (changed && (wasShown || state.threads.some(showsRecommendations))) {
                        renderState(captureComposerFocus());
                    }
                    return;
                }
                if (message.type === 'fileSearchResults') {
                    // A reply that lands after the mention closed, for another pane or for an
                    // older query must not revive the menu or feed Enter.
                    if (!composerUi.atMentionThreadId || message.threadId !== composerUi.atMentionThreadId ||
                        message.query !== composerUi.fileSearchQuery) {
                        return;
                    }
                    composerUi.fileResults = Array.isArray(message.files) ? message.files : [];
                    composerUi.activeFileIndex = 0;
                    renderState(captureComposerFocus());
                    return;
                }
                if (message.type === 'insertMention') {
                    var mention = String(message.mention || '');
                    var target = getActiveThread();
                    if (mention && target) {
                        var draft = getDraft(target.id);
                        var nextDraft = !draft || /\\s$/.test(draft) ? draft + mention : draft + ' ' + mention;
                        setDraft(target.id, nextDraft);
                        renderState({
                            threadId: target.id,
                            selectionStart: nextDraft.length,
                            selectionEnd: nextDraft.length
                        });
                    }
                    return;
                }
                if (message.type === 'sessionsList') {
                    renderSessionsPanel({
                        sessions: Array.isArray(message.sessions) ? message.sessions : [],
                        error: message.error,
                        threadId: message.threadId
                    });
                    return;
                }
                if (message.type === 'agentSelected') {
                    dismissSessionsPanel();
                    return;
                }
                if (message.type === 'sessionsChanged') {
                    refreshSessionsPanel();
                    return;
                }
                if (message.type === 'transportStatus') {
                    var badge = document.getElementById('claw-transport-status');
                    if (!badge) {
                        badge = document.createElement('div');
                        badge.id = 'claw-transport-status';
                        badge.style.cssText = 'position:fixed;top:4px;right:8px;font-size:10px;opacity:0.6;z-index:50;pointer-events:none';
                        document.body.appendChild(badge);
                    }
                    badge.textContent = String(message.label || '');
                    return;
                }
                if (message.type === 'sendRejected') {
                    // Later queued drafts would meet the same refusal: they return to the composer too.
                    restoreRejectedSend(String(message.threadId || ''), message.clientId);
                    restoreQueuedMessage(String(message.threadId || ''));
                    return;
                }
                if (message.type === 'sendAccepted') {
                    takeUnconfirmedSend(String(message.threadId || ''), message.clientId);
                    // The idle snapshot may have landed before this acknowledgement and held the queue back.
                    if (getQueue(String(message.threadId || '')).length) {
                        drainQueuedMessages();
                        renderState(captureComposerFocus());
                    }
                    return;
                }
                if (message.type === 'textUpdate') {
                    applyTextUpdate(message.threadId, String(message.text || ''));
                    return;
                }
                if (message.type === 'state') {
                    var focus = captureComposerFocus();
                    state.activeThreadId = message.activeThreadId || '';
                    state.threads = Array.isArray(message.threads) ? message.threads : [];
                    availableModels = Array.isArray(message.models) ? message.models.map(String) : [];
                    if (typeof message.collapseCompleted === 'boolean') {
                        collapseCompleted = message.collapseCompleted;
                    }
                    if (typeof message.hideToolActivity === 'boolean') {
                        hideToolActivity = message.hideToolActivity;
                    }
                    if (isValidDimension(message.dimension)) {
                        currentDimension = message.dimension;
                    }
                    dimensionSelect.value = currentDimension;
                    updateGridDimension(currentDimension);
                    drainQueuedMessages();
                    renderState(focus);
                }
            }

${SESSIONS_PANEL_JS}
${OPERATOR_PROMPTS_JS}
            function hasFileDrag(dataTransfer) {
                if (!dataTransfer || !dataTransfer.types) {
                    return false;
                }
                var types = dataTransfer.types;
                var hasType = typeof types.indexOf === 'function'
                    ? function(t) { return types.indexOf(t) !== -1; }
                    : function(t) { return Array.prototype.indexOf.call(types, t) !== -1; };
                return hasType('Files') || hasType('text/uri-list');
            }

            function fileUriToPath(uri) {
                var decoded = decodeURIComponent(uri.slice('file://'.length));
                if (/^\\/[A-Za-z]:/.test(decoded)) {
                    return decoded.substring(1);
                }
                // file://server/share/x carries the host as authority: a UNC path.
                return decoded.charAt(0) === '/' ? decoded : '//' + decoded;
            }

            /** Local paths from a text/uri-list drag (VS Code explorer); webview File objects carry no path. */
            function extractDroppedPaths(dataTransfer) {
                var paths = [];
                var uriList = '';
                try {
                    uriList = dataTransfer.getData('text/uri-list') || '';
                } catch (e) {
                    console.warn('[OpenClaw DnD] Could not read text/uri-list:', e);
                }
                uriList.split(/\\r?\\n/).forEach(function(rawLine) {
                    var line = rawLine.trim();
                    if (line.indexOf('file://') !== 0) {
                        return;
                    }
                    try {
                        var filePath = fileUriToPath(line);
                        if (paths.indexOf(filePath) === -1) {
                            paths.push(filePath);
                        }
                    } catch (e) {
                        console.warn('[OpenClaw DnD] Skipping malformed file URI:', line);
                    }
                });
                if (!paths.length) {
                    console.warn('[OpenClaw DnD] Could not extract file paths from drop. dataTransfer.types:', Array.from(dataTransfer.types));
                }
                return paths;
            }

            renderDimensionOptions();
            updateGridDimension(currentDimension);
            try {
                renderState();
            } catch (e) {
                _showCrash('Initial render failed', e);
            }
            try {
                vscode.postMessage({ type: 'requestState' });
                vscode.postMessage({ type: 'requestRecommendations' });
            } catch (e) {
                _showCrash('Failed to request initial state from extension host', e);
            }
        })();
`;
