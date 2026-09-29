// src/content/buildDomTree.ts

export interface DOMNode {
  elementId?: number;
  tagName: string;
  text?: string;
  attributes?: Record<string, string>;
  children?: DOMNode[];
}

let elementIdCounter = 1;
const interactableElements = new Map<number, HTMLElement>();

function isElementVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0' &&
    el.offsetWidth > 0 &&
    el.offsetHeight > 0
  );
}

function isInteractable(el: HTMLElement): boolean {
  const tagName = el.tagName.toLowerCase();
  if (['a', 'button', 'input', 'select', 'textarea'].includes(tagName)) return true;
  if (el.hasAttribute('onclick') || el.getAttribute('role') === 'button') return true;
  return false;
}

export function buildDomTree(): { tree: DOMNode, interactables: Map<number, HTMLElement> } {
  elementIdCounter = 1;
  interactableElements.clear();

  function traverse(node: Node): DOMNode | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        return { tagName: 'TEXT', text };
      }
      return null;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const el = node as HTMLElement;
    const tagName = el.tagName.toLowerCase();

    // Skip script, style, noscript, svg, etc.
    if (['script', 'style', 'noscript', 'svg', 'iframe', 'canvas', 'video', 'audio'].includes(tagName)) {
      return null;
    }

    if (!isElementVisible(el)) return null;

    const domNode: DOMNode = { tagName };
    let isRelevant = false;

    // Check if interactable
    if (isInteractable(el)) {
      const id = elementIdCounter++;
      domNode.elementId = id;
      interactableElements.set(id, el);
      isRelevant = true;

      // Extract important attributes
      const attrs: Record<string, string> = {};
      if (el.hasAttribute('href')) attrs.href = el.getAttribute('href')!;
      if (el.hasAttribute('type')) attrs.type = el.getAttribute('type')!;
      if (el.hasAttribute('placeholder')) attrs.placeholder = el.getAttribute('placeholder')!;
      if (el.hasAttribute('value')) attrs.value = (el as HTMLInputElement).value;
      if (el.hasAttribute('aria-label')) attrs.ariaLabel = el.getAttribute('aria-label')!;
      if (Object.keys(attrs).length > 0) domNode.attributes = attrs;
    }

    const children: DOMNode[] = [];
    for (const child of Array.from(el.childNodes)) {
      const childDomNode = traverse(child);
      if (childDomNode) {
        children.push(childDomNode);
        isRelevant = true; // If a child is relevant (e.g. text or button), this node might be needed for structure
      }
    }

    if (children.length > 0) {
      // Flatten structure if it's just a layout div with one relevant child
      if (tagName === 'div' && !isInteractable(el) && children.length === 1 && !children[0].text) {
        return children[0];
      }
      domNode.children = children;
    }

    // Only return the node if it's relevant (interactable or contains relevant children/text)
    if (isRelevant || (domNode.children && domNode.children.length > 0)) {
      return domNode;
    }

    return null;
  }

  const tree = traverse(document.body) || { tagName: 'body' };
  return { tree, interactables: interactableElements };
}
