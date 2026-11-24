import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { foldEffect, unfoldEffect } from "@codemirror/language";
import { OrgFoldInfo, orgFoldableItems } from "./fold";
import { createDetachedEl } from "../../util/dom";

class OrgFoldWidget extends WidgetType {
  constructor(readonly info: OrgFoldInfo) {
    super();
  }

  eq(other: OrgFoldWidget): boolean {
    return (
      other.info.kind === this.info.kind &&
      other.info.from === this.info.from &&
      other.info.to === this.info.to &&
      other.info.folded === this.info.folded
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const span = createDetachedEl("span");
    const subKind = this.info.blockType ? `-${this.info.blockType}` : "";
    span.className = `org-fold-indicator org-fold-indicator-${this.info.kind}${subKind}${
      this.info.folded ? " is-folded" : ""
    }`;
    span.title = this.info.folded ? `Unfold ${this.info.kind}` : `Fold ${this.info.kind}`;
    span.setAttribute("role", "button");
    span.setAttribute("aria-label", span.title);
    span.setAttribute("aria-expanded", this.info.folded ? "false" : "true");

    const chevron = createDetachedEl("span");
    chevron.className = "org-fold-chevron";
    chevron.setAttribute("aria-hidden", "true");
    span.appendChild(chevron);

    span.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const foldRange = { from: this.info.from, to: this.info.to };
      const effect = this.info.folded
        ? unfoldEffect.of(foldRange)
        : foldEffect.of(foldRange);
      const touchesFoldBody =
        !this.info.folded &&
        view.state.selection.ranges.some(
          (sel) => sel.to > foldRange.from && sel.from <= foldRange.to
        );
      view.dispatch({
        effects: effect,
        ...(touchesFoldBody ? { selection: { anchor: foldRange.from } } : {}),
      });
      view.focus();
    });
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges = [];
  const visible = view.visibleRanges;
  for (const info of orgFoldableItems(view.state)) {
    if (info.kind === "block" && info.blockType === "src") continue;
    const line = view.state.doc.line(info.indicatorLine + 1);
    const inView = visible.some((range) => line.to >= range.from && line.from <= range.to);
    if (!inView) continue;
    ranges.push(
      Decoration.widget({
        widget: new OrgFoldWidget(info),
        side: -1,
      }).range(line.from)
    );
  }
  return Decoration.set(ranges, true);
}

export function orgFoldIndicators() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        const foldChanged = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(foldEffect) || effect.is(unfoldEffect))
        );
        if (update.docChanged || update.viewportChanged || foldChanged) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (value) => value.decorations,
    }
  );
}
