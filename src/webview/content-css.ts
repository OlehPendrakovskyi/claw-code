// Mechanical extraction of the <style> block from the original getWebviewContent template.
// Content is verbatim; no refactoring.
export const CONTENT_CSS = `
        :root {
            --openclaw-brand-red: #F80615;
            --openclaw-brand-red-hover: #CF0511;
            --openclaw-brand-red-soft: rgba(248, 6, 21, 0.08);
            --openclaw-brand-red-strong: rgba(248, 6, 21, 0.14);
            --openclaw-brand-red-border: rgba(248, 6, 21, 0.18);
            --openclaw-brand-red-active: rgba(248, 6, 21, 0.44);
            --openclaw-surface-raised: rgba(255, 255, 255, 0.04);
            --openclaw-surface-border: rgba(255, 255, 255, 0.08);
            --openclaw-neutral-border: rgba(255, 255, 255, 0.10);
            --openclaw-neutral-border-strong: rgba(255, 255, 255, 0.16);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
            height: 100vh;
            overflow: hidden;
        }

        button, textarea, input {
            font: inherit;
        }

        button {
            color: inherit;
        }

        .app {
            height: 100vh;
            display: grid;
            grid-template-rows: auto 1fr;
        }

        .header {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px 0;
            background: transparent;
        }

        .header-brand {
            min-width: 0;
            flex: 1;
            padding: 8px 11px;
            border-radius: 12px;
            border: 1px solid var(--openclaw-brand-red-border);
            background:
                linear-gradient(135deg, rgba(248, 6, 21, 0.12), rgba(248, 6, 21, 0.03) 62%, transparent),
                var(--openclaw-surface-raised);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
        }

        .header-title {
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--openclaw-brand-red);
            opacity: 0.94;
        }

        .header-subtitle {
            margin-top: 2px;
            font-size: 12px;
            opacity: 0.6;
        }

        .header-actions {
            margin-left: auto;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .icon-btn {
            width: 28px;
            height: 28px;
            border-radius: 999px;
            border: 1px solid var(--openclaw-surface-border);
            background: var(--openclaw-surface-raised);
            cursor: pointer;
            opacity: 0.72;
            transition: opacity 0.15s, background 0.15s, border-color 0.15s;
        }

        .icon-btn:hover {
            opacity: 1;
            background: var(--openclaw-brand-red-soft);
            border-color: var(--openclaw-surface-border);
        }

        .workspace {
            min-height: 0;
            display: flex;
            flex-direction: column;
        }

        .pane-grid {
            flex: 1;
            min-height: 0;
            padding: 8px 12px 12px;
            display: grid;
            grid-template-columns: repeat(var(--grid-cols, 1), minmax(280px, 1fr));
            grid-template-rows: repeat(var(--grid-rows, 1), 1fr);
            gap: 10px;
            overflow: auto;
        }

        .pane {
            min-height: 0;
            display: grid;
            grid-template-rows: auto minmax(160px, 1fr) auto;
            border-radius: 14px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            background:
                linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.01)),
                var(--vscode-editor-background);
            overflow: hidden;
            transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }

        .pane:hover {
            border-color: rgba(255, 255, 255, 0.12);
        }

        .pane.active {
            border-color: rgba(255, 255, 255, 0.12);
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
        }

        .pane.active:hover,
        .pane.active:focus-within {
            border-color: rgba(255, 255, 255, 0.12);
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
        }

        .pane.collapsed {
            grid-template-rows: auto;
            min-height: 0;
            cursor: pointer;
            opacity: 0.75;
            transition: opacity 0.15s ease;
        }

        .pane.collapsed:hover {
            opacity: 1;
        }

        .pane.collapsed .pane-body,
        .pane.collapsed .composer-shell {
            display: none;
        }

        .pane.collapsed .pane-header {
            border-bottom: none;
            padding: 8px 10px;
        }

        .pane-collapse-btn {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground, #888);
            cursor: pointer;
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 4px;
            opacity: 0.7;
            transition: opacity 0.15s ease;
        }

        .pane-collapse-btn:hover {
            opacity: 1;
            background: rgba(255, 255, 255, 0.06);
        }

        .pane-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px 10px 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }

        .pane-header-main {
            min-width: 0;
            flex: 1;
        }

        .pane-title {
            font-size: 12px;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .pane-meta {
            margin-top: 4px;
            display: flex;
            gap: 6px;
            align-items: center;
            flex-wrap: wrap;
            font-size: 11px;
            opacity: 0.75;
        }

        .pane-pill {
            display: inline-flex;
            align-items: center;
            padding: 2px 7px;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.06);
        }

        .pane-status {
            font-weight: 600;
            border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .pane-status.complete {
            color: var(--vscode-testing-iconPassed, var(--vscode-textLink-foreground, var(--vscode-foreground)));
        }

        .pane-status.running {
            color: var(--vscode-textLink-foreground, var(--vscode-foreground));
        }

        .pane-status.error,
        .pane-status.cancelled {
            color: var(--vscode-errorForeground, #f48771);
        }

        .pane-source {
            font-weight: 600;
            letter-spacing: 0.03em;
            border: 1px solid rgba(255, 255, 255, 0.10);
        }

        .pane-source.api { color: var(--vscode-textLink-foreground, #3794ff); }
        .pane-source.oauth { color: #c678dd; }
        .pane-source.gateway { color: #e5c07b; }
        .pane-source.local { color: #98c379; }

        .pane-context {
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }

        .context-bar {
            width: 48px;
            height: 5px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.08);
            overflow: hidden;
        }

        .context-bar-fill {
            height: 100%;
            border-radius: 3px;
            background: var(--openclaw-brand-red);
            transition: width 0.3s ease;
        }

        .context-bar-fill.warn {
            background: #e5c07b;
        }

        .context-bar-fill.critical {
            background: var(--vscode-errorForeground, #f48771);
        }

        .context-label {
            white-space: nowrap;
        }

        .composer-token-est {
            font-size: 10px;
            opacity: 0.5;
            white-space: nowrap;
            transition: opacity 0.15s;
        }

        .composer-token-est.has-value {
            opacity: 0.68;
        }

        .pane-actions {
            display: flex;
            gap: 4px;
        }

        .pane-btn {
            min-width: 0;
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(255, 255, 255, 0.04);
            color: inherit;
            border-radius: 8px;
            padding: 4px 8px;
            font-size: 11px;
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s;
        }

        .pane-btn:hover {
            background: rgba(255, 255, 255, 0.08);
            border-color: rgba(255, 255, 255, 0.14);
        }

        .pane-body {
            min-height: 0;
            overflow-y: auto;
            padding: 4px 6px 6px;
            display: flex;
            flex-direction: column;
            gap: 3px;
        }

        .pane-empty {
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 18px;
            border: 1px dashed rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            color: var(--vscode-descriptionForeground, var(--vscode-foreground));
            opacity: 0.62;
            line-height: 1.5;
        }

        .message {
            line-height: 1.25;
            white-space: pre-wrap;
            word-break: break-word;
            font-size: 13px;
        }

        .message-user {
            padding-left: 6px;
            border-left: 2px solid var(--openclaw-brand-red);
            opacity: 0.78;
        }

        .message-assistant {
            color: var(--vscode-foreground);
        }

        .message-assistant > :first-child {
            margin-top: 0;
        }

        .message-assistant > :last-child {
            margin-bottom: 0;
        }

        .message-assistant h1,
        .message-assistant h2,
        .message-assistant h3,
        .message-assistant h4,
        .message-assistant h5,
        .message-assistant h6 {
            margin: 0 0 2px;
            line-height: 1.1;
        }

        .message-assistant p,
        .message-assistant ul,
        .message-assistant ol,
        .message-assistant pre,
        .message-assistant blockquote {
            margin: 0 0 3px;
        }

        .message-assistant ul,
        .message-assistant ol {
            padding-left: 14px;
        }

        .message-assistant li + li {
            margin-top: 0;
        }

        .file-link {
            color: var(--vscode-textLink-foreground, #3794ff);
            cursor: pointer;
            text-decoration: none;
            border-bottom: 1px solid transparent;
        }
        .file-link:hover {
            border-bottom-color: var(--vscode-textLink-foreground, #3794ff);
        }
        .file-link:focus-visible {
            outline: 1px solid var(--vscode-focusBorder, #007acc);
            outline-offset: 2px;
            border-bottom-color: var(--vscode-textLink-foreground, #3794ff);
        }

        .message-pending::after {
            content: '';
            display: inline-block;
            width: 6px;
            height: 14px;
            margin-left: 2px;
            background: var(--openclaw-brand-red);
            border-radius: 1px;
            vertical-align: text-bottom;
            animation: blink 0.8s step-end infinite;
        }

        @keyframes blink {
            50% { opacity: 0; }
        }

        .message-error {
            color: var(--vscode-errorForeground, #f48771);
            font-size: 12px;
        }

        .message-tool {
            align-self: stretch;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(255, 255, 255, 0.03);
            overflow: hidden;
            margin: 2px 0;
        }

        .message-tool summary {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 6px 10px;
            cursor: pointer;
            list-style: none;
            font-size: 11px;
            user-select: none;
            transition: background 0.15s;
        }

        .message-tool summary:hover {
            background: rgba(255, 255, 255, 0.04);
        }

        .message-tool summary::-webkit-details-marker {
            display: none;
        }

        .message-tool-summary {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }

        .message-tool-chevron {
            display: inline-block;
            width: 12px;
            height: 12px;
            opacity: 0.6;
            transition: transform 0.15s ease;
            flex-shrink: 0;
        }

        .message-tool[open] .message-tool-chevron {
            transform: rotate(90deg);
        }

        .message-tool-icon {
            opacity: 0.65;
            font-size: 12px;
        }

        .message-tool-label {
            opacity: 0.85;
        }

        .message-tool-count {
            opacity: 0.5;
            font-size: 10px;
        }

        .message-tool-status {
            opacity: 0.5;
            text-transform: lowercase;
            font-size: 10px;
        }

        .message-tool-status.tool-ok,
        .message-tool-entry-status.tool-ok {
            color: var(--vscode-testing-iconPassed, #73c991);
            opacity: 0.9;
        }

        .message-tool-status.tool-fail,
        .message-tool-entry-status.tool-fail {
            color: var(--vscode-errorForeground, #f48771);
            opacity: 0.9;
        }

        .message-tool-status.tool-run,
        .message-tool-entry-status.tool-run {
            color: var(--vscode-charts-yellow, #cca700);
            opacity: 0.9;
        }

        .message-tool-body {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 0 10px 8px;
        }

        .message-tool-entry {
            padding-top: 6px;
            border-top: 1px solid rgba(255, 255, 255, 0.05);
        }

        .message-tool-entry:first-child {
            padding-top: 0;
            border-top: 0;
        }

        .message-tool-entry-header {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 10px;
            margin-bottom: 3px;
            font-size: 11px;
        }

        .message-tool-entry-title {
            font-weight: 600;
            word-break: break-word;
            opacity: 0.85;
        }

        .message-tool-entry-status {
            opacity: 0.5;
            text-transform: lowercase;
            white-space: nowrap;
            font-size: 10px;
        }

        .message-tool-details {
            margin: 0;
            padding: 6px 8px;
            border-radius: 6px;
            background: rgba(0, 0, 0, 0.18);
            font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
            font-size: 11px;
            line-height: 1.45;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 200px;
            overflow-y: auto;
        }

        .composer-shell {
            position: relative;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            background:
                linear-gradient(180deg, rgba(0, 0, 0, 0.04), transparent),
                var(--vscode-sideBar-background, var(--vscode-editor-background));
        }

        .file-dropdown,
        .slash-dropdown,
        .selector-dropdown {
            position: absolute;
            left: 10px;
            right: 10px;
            bottom: calc(100% - 2px);
            display: none;
            max-height: 260px;
            overflow: auto;
            border-radius: 12px;
            border: 1px solid var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.08));
            background: var(--vscode-editorWidget-background, var(--vscode-dropdown-background, #252526));
            box-shadow: 0 10px 28px rgba(0, 0, 0, 0.32);
            padding: 4px;
            z-index: 10;
        }

        .file-dropdown.visible,
        .slash-dropdown.visible,
        .selector-dropdown.visible {
            display: block;
        }

        .composer-card {
            position: relative;
            margin: 10px;
            border-radius: 16px;
            border: none;
            background: var(--vscode-input-background);
            overflow: hidden;
            transition: background 0.15s, box-shadow 0.15s;
        }

        .composer-card:focus-within {
            box-shadow: none;
        }

        .composer-card.drag-active {
            border-color: var(--openclaw-neutral-border-strong);
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
        }

        .drop-overlay {
            position: absolute;
            inset: 0;
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 4px;
            background: var(--openclaw-brand-red-soft);
            backdrop-filter: blur(2px);
            border: 2px dashed var(--openclaw-surface-border);
            border-radius: 14px;
            z-index: 2;
            pointer-events: none;
        }

        .drop-overlay-icon {
            font-size: 24px;
            line-height: 1;
        }

        .drop-overlay-label {
            font-size: 12px;
            font-weight: 600;
            color: var(--openclaw-brand-red);
        }

        .drop-overlay.visible {
            display: flex;
        }

        .composer-top {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px 0;
        }

        .composer-target {
            min-width: 0;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.06);
            font-size: 11px;
            opacity: 0.8;
        }

        .composer-target strong {
            font-size: 11px;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 180px;
        }

        .composer-top-spacer {
            flex: 1;
        }

        .dropdown-trigger {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            border: none;
            background: none;
            color: inherit;
            cursor: pointer;
            font-size: 12px;
            opacity: 0.68;
            padding: 4px 6px;
            border-radius: 8px;
        }

        .dropdown-trigger:hover {
            opacity: 1;
            background: rgba(255, 255, 255, 0.05);
        }

        .composer-input {
            width: 100%;
            resize: none;
            border: none;
            background: transparent;
            color: var(--vscode-input-foreground);
            outline: none;
            min-height: 64px;
            max-height: 180px;
            padding: 10px 12px 4px;
            line-height: 1.5;
        }

        .composer-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        .slash-hint {
            display: none;
            padding: 0 12px 4px;
            font-size: 11px;
            opacity: 0.52;
        }

        .slash-hint.visible {
            display: block;
        }

        .attachments {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
            padding: 0 10px 6px;
        }

        .attachments:empty {
            display: none;
        }

        .composer-recommendations {
            padding: 0 10px 4px;
        }

        .composer-recommendations.hidden {
            display: none;
        }

        .rec-toggle {
            border: none;
            background: transparent;
            cursor: pointer;
            font-size: 11px;
            color: var(--vscode-descriptionForeground, rgba(255, 255, 255, 0.34));
            padding: 2px 4px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            transition: color 0.15s;
        }

        .rec-toggle:hover {
            color: var(--vscode-foreground, rgba(255, 255, 255, 0.6));
        }

        .rec-toggle .rec-caret {
            font-size: 8px;
            transition: transform 0.15s;
        }

        .rec-toggle.open .rec-caret {
            transform: rotate(90deg);
        }

        .att-pill {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            max-width: 240px;
            border-radius: 8px;
            padding: 4px 8px 4px 6px;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.1);
            font-size: 11px;
            transition: background 0.15s, border-color 0.15s;
        }

        .att-pill:hover {
            background: rgba(255, 255, 255, 0.1);
            border-color: rgba(255, 255, 255, 0.16);
        }

        .att-pill-icon {
            font-size: 12px;
            flex-shrink: 0;
            opacity: 0.8;
        }

        .att-pill.att-image {
            border-color: var(--openclaw-brand-red-border);
        }

        .att-pill.att-image .att-pill-icon {
            color: var(--openclaw-brand-red);
        }

        .att-pill-thumb {
            width: 28px;
            height: 28px;
            border-radius: 4px;
            object-fit: cover;
            flex-shrink: 0;
        }

        .att-pill.att-image {
            padding-left: 3px;
        }

        .att-pill-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .att-pill-remove {
            border: none;
            background: none;
            color: inherit;
            cursor: pointer;
            opacity: 0.45;
            font-size: 13px;
            line-height: 1;
            padding: 0 1px;
            transition: opacity 0.15s;
        }

        .att-pill-remove:hover {
            opacity: 1;
        }

        .att-count {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.1);
            font-size: 11px;
            opacity: 0.72;
        }

        .composer-footer {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 0 8px 8px;
        }

        .composer-status {
            font-size: 11px;
            opacity: 0.58;
        }

        .btn-attach,
        .btn-send {
            width: 30px;
            height: 30px;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .btn-attach {
            background: transparent;
            opacity: 0.75;
        }

        .btn-attach:hover {
            background: rgba(255, 255, 255, 0.06);
            opacity: 1;
        }

        .btn-send {
            margin-left: auto;
            border-radius: 999px;
            border: 1px solid var(--openclaw-surface-border);
            background: rgba(255, 255, 255, 0.06);
            color: rgba(255, 255, 255, 0.84);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
            transition: background 0.15s, border-color 0.15s, color 0.15s;
        }

        .btn-send:hover {
            background: rgba(248, 6, 21, 0.14);
            border-color: var(--openclaw-surface-border);
            color: #fff;
        }

        .btn-send.streaming {
            border-color: var(--openclaw-surface-border);
            background: rgba(248, 6, 21, 0.18);
            color: #fff;
        }

        .queued-indicator {
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #888);
            margin-right: 6px;
            font-style: italic;
        }

        .selector-search {
            width: calc(100% - 8px);
            margin: 4px;
            border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.3));
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 8px;
            padding: 6px 8px;
            outline: none;
        }

        .selector-item,
        .slash-item,
        .file-item {
            display: flex;
            align-items: center;
            gap: 8px;
            border-radius: 8px;
            padding: 7px 9px;
            cursor: pointer;
        }

        .selector-item:hover,
        .selector-item.selected,
        .slash-item:hover,
        .slash-item.active,
        .file-item:hover,
        .file-item.active {
            background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.06));
        }

        .selector-item-label,
        .slash-info,
        .file-item-name {
            min-width: 0;
            flex: 1;
        }

        .selector-item-check {
            opacity: 0;
            font-size: 11px;
        }

        .selector-item.selected .selector-item-check {
            opacity: 0.7;
        }

        .slash-info {
            display: flex;
            flex-direction: column;
        }

        .slash-name {
            font-weight: 600;
            font-size: 12px;
        }

        .slash-desc,
        .file-item-path {
            font-size: 11px;
            opacity: 0.55;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .settings-dropdown {
            position: absolute;
            left: 10px;
            right: 10px;
            bottom: calc(100% - 2px);
            display: none;
            max-height: 320px;
            overflow: auto;
            border-radius: 12px;
            border: 1px solid var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.08));
            background: var(--vscode-editorWidget-background, var(--vscode-dropdown-background, #252526));
            box-shadow: 0 10px 28px rgba(0, 0, 0, 0.32);
            padding: 10px;
            z-index: 10;
        }

        .settings-dropdown.visible {
            display: block;
        }

        .settings-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 6px 4px;
        }

        .settings-row + .settings-row {
            border-top: 1px solid rgba(255, 255, 255, 0.06);
        }

        .settings-label {
            font-size: 11px;
            font-weight: 600;
            opacity: 0.85;
            white-space: nowrap;
        }

        .settings-control select,
        .settings-control input[type="range"] {
            font: inherit;
            font-size: 11px;
            height: 24px;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(255, 255, 255, 0.06);
            color: inherit;
            cursor: pointer;
            padding: 0 6px;
        }

        .settings-control input[type="range"] {
            width: 80px;
            padding: 0;
        }

        .settings-value {
            font-size: 10px;
            opacity: 0.6;
            min-width: 28px;
            text-align: right;
        }

        .recommendations {
            display: none;
            flex-direction: column;
            gap: 0;
            padding: 2px 0 0;
        }

        .recommendations.open {
            display: flex;
        }

        .rec-chip {
            border: none;
            background: transparent;
            border-radius: 3px;
            padding: 2px 6px;
            cursor: pointer;
            font-size: 11px;
            text-align: left;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--vscode-descriptionForeground, rgba(255, 255, 255, 0.38));
            transition: color 0.12s, background 0.12s;
        }

        .rec-chip:hover {
            color: var(--vscode-foreground, rgba(255, 255, 255, 0.7));
            background: rgba(255, 255, 255, 0.05);
        }

        .empty-detail {
            max-width: 280px;
        }

        .openclaw-crash {
            padding: 16px;
            margin: 10px;
            border-radius: 10px;
            background: rgba(244, 135, 113, 0.08);
            border: 1px solid var(--vscode-errorForeground, #f48771);
            font-size: 12px;
            line-height: 1.6;
        }

        .openclaw-crash summary {
            cursor: pointer;
            font-weight: 600;
            color: var(--vscode-errorForeground, #f48771);
            list-style: none;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .openclaw-crash summary::before {
            content: '\\26A0';
        }

        .openclaw-crash pre {
            margin-top: 8px;
            padding: 8px;
            border-radius: 6px;
            background: rgba(0, 0, 0, 0.2);
            font-size: 11px;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 200px;
            overflow-y: auto;
        }

        pre {
            overflow: auto;
            background: rgba(128, 128, 128, 0.14);
            border-radius: 8px;
            padding: 6px;
            margin: 2px 0;
        }

        code {
            font-family: var(--vscode-editor-font-family);
            background: rgba(128, 128, 128, 0.14);
            padding: 0 2px;
            border-radius: 4px;
        }

        pre code {
            background: none;
            padding: 0;
        }

        .dimension-select {
            height: 28px;
            min-width: 56px;
            padding: 0 10px;
            font-size: 11px;
            border-radius: 999px;
            border: 1px solid var(--openclaw-surface-border);
            background: var(--openclaw-surface-raised);
            color: inherit;
            cursor: pointer;
        }

        .dimension-select:hover {
            background: var(--openclaw-brand-red-soft);
            border-color: var(--openclaw-surface-border);
        }

        .dimension-select:focus-visible {
            outline: 1px solid var(--openclaw-surface-border);
            outline-offset: 1px;
        }

        @media (max-width: 780px) {
            .pane-grid {
                grid-template-columns: 1fr;
            }

            .header-subtitle {
                display: none;
            }
        }
`;
