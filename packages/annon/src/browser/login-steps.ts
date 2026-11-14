import type { PageElements } from './login-dom.js';

/** Completed steps contain snapshots of text and review content, never live controls. */
export function approvalSteps(doc: Document, el: PageElements) {
  const list = doc.getElementById('steps') as HTMLElement;
  return {
    finish() {
      const step = doc.createElement('details');
      step.className = 'step done';
      const heading = doc.createElement('summary');
      const mark = doc.createElement('span');
      mark.className = 'done-mark';
      mark.textContent = '✓ Done';
      const title = doc.createElement('span');
      title.textContent = el.title.textContent;
      heading.append(mark, title);
      const content = el.summary.cloneNode(true) as HTMLElement;
      // Snapshots have no IDs, so only the current request owns page references.
      content.removeAttribute('id');
      for (const node of Array.from(content.querySelectorAll('[id]'))) node.removeAttribute('id');
      const technical = doc.createElement('pre');
      technical.textContent = el.action.textContent;
      step.append(heading, content, technical);
      list.append(step);
    },
  };
}
