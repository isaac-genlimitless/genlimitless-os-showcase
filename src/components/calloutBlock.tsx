"use client";

import { useEffect, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { CALLOUT_COLORS, CALLOUT_ICONS, calloutConfig } from "@/lib/calloutBlock";

// Notion-style callout: an emoji button (opens an emoji + color popover) beside editable text.

export const calloutBlock = createReactBlockSpec(calloutConfig, {
  render: ({ block, editor, contentRef }) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- render is a component
    const [open, setOpen] = useState(false);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const wrap = useRef<HTMLDivElement>(null);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      if (!open) return;
      const onDown = (e: MouseEvent) => {
        if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setOpen(false);
      };
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onDown);
        document.removeEventListener("keydown", onKey);
      };
    }, [open]);

    const update = (props: { icon?: string; color?: string }) => {
      editor.updateBlock(block, { props } as never);
    };

    return (
      <div className="callout" data-testid="callout" data-color={block.props.color}>
        <div className="callout-icon-wrap" contentEditable={false} ref={wrap}>
          <button type="button" className="callout-icon" data-testid="callout-icon" onClick={() => setOpen((o) => !o)}>
            {block.props.icon}
          </button>
          {open && (
            <div className="callout-popover">
              <div className="callout-emojis">
                {CALLOUT_ICONS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    data-testid="callout-emoji-option"
                    onClick={() => {
                      update({ icon: e });
                      setOpen(false);
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
              <div className="callout-colors">
                {CALLOUT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    aria-label={c}
                    data-testid="callout-color-option"
                    data-color={c}
                    className="callout-swatch"
                    onClick={() => {
                      update({ color: c });
                      setOpen(false);
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="callout-text" ref={contentRef} />
      </div>
    );
  },
  toExternalHTML: ({ block, contentRef }) => (
    <blockquote>
      <p>
        {block.props.icon} <span ref={contentRef} />
      </p>
    </blockquote>
  ),
});
