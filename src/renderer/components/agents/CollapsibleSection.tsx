import React, { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

interface CollapsibleSectionProps {
  title: string
  /** Whether the section starts expanded. Defaults to true. */
  defaultOpen?: boolean
  /** Muted, right-aligned content shown in the header only while collapsed. */
  summary?: React.ReactNode
  /** Accent border to mark a primary section (e.g. the Prompt). */
  hero?: boolean
  children: React.ReactNode
}

/**
 * A labelled, collapsible card used to group the fields of the agent Configure
 * screen. Clicking the title row toggles expansion; a collapsed section shows a
 * summary line so its state stays visible without expanding.
 */
export function CollapsibleSection({
  title,
  defaultOpen = true,
  summary,
  hero = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div
      className={cn(
        'rounded-lg border bg-[var(--bg-secondary)]',
        hero ? 'border-[var(--accent)]/50' : 'border-[var(--border)]'
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-left group"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
        ) : (
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
        )}
        <span className="text-sm font-semibold text-[var(--text-primary)] flex-shrink-0">
          {title}
        </span>
        {!open && summary != null && (
          <span className="ml-auto truncate text-xs text-[var(--text-secondary)] opacity-60 font-mono">
            {summary}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3.5 pb-4 pt-1 border-t border-[var(--border)] space-y-5">
          {children}
        </div>
      )}
    </div>
  )
}
