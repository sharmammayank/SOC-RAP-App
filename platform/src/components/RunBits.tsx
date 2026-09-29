import { Check } from "lucide-react";
import type { RunStatus } from "@/lib/db";
import { Chip, cx } from "./ui";

export function RunStatusChip({ status }: { status: RunStatus }) {
  const m: Record<RunStatus, [Parameters<typeof Chip>[0]["tone"], string]> = {
    draft: ["neutral", "Draft"],
    staged: ["info", "Staged"],
    review: ["warn", "In review"],
    published: ["good", "Published"],
    superseded: ["neutral", "Superseded"],
  };
  const [tone, label] = m[status];
  return <Chip tone={tone}>{label}</Chip>;
}

export const STEPS = ["Upload", "Map columns", "Classify & validate", "Review", "Publish"] as const;

/** Persistent progress rail for the five-step wizard (spec §7.1). */
export function StepRail({ current, done, onPick }: { current: number; done: number; onPick?: (i: number) => void }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface p-1.5" aria-label="Run progress">
      {STEPS.map((s, i) => {
        const isDone = i < done,
          isCur = i === current;
        const clickable = onPick && i <= done && i !== current;
        return (
          <li key={s} className="flex items-center">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onPick!(i)}
              aria-current={isCur ? "step" : undefined}
              className={cx(
                "flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition",
                isCur ? "bg-accent text-accent-ink" : isDone ? "text-ink hover:bg-surface-2" : "text-muted",
                !clickable && "cursor-default",
              )}
            >
              <span className={cx("grid size-5 place-items-center rounded-full text-[11px] font-semibold", isCur ? "bg-white/25" : isDone ? "bg-good-bg text-good" : "bg-surface-2 ring-1 ring-line")}>
                {isDone && !isCur ? <Check className="size-3" /> : i + 1}
              </span>
              {s}
            </button>
            {i < STEPS.length - 1 && <span aria-hidden className="mx-0.5 h-px w-4 bg-line-strong" />}
          </li>
        );
      })}
    </ol>
  );
}
