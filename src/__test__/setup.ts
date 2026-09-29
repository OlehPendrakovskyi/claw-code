// @create-markdown/preview defines a web-component class at import time; Node has no HTMLElement.
if (!('HTMLElement' in globalThis)) {
    Object.assign(globalThis, { HTMLElement: class HTMLElement {} });
}
