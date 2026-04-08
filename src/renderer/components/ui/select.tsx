import React from 'react'
import { cn } from '@renderer/lib/utils'
import { ChevronDown } from 'lucide-react'

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, label, id, ...props }, ref) => {
    return (
      <div className="relative">
        {label && (
          <label
            htmlFor={id}
            className="block text-xs font-medium text-[var(--text-secondary)] mb-1"
          >
            {label}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            id={id}
            className={cn(
              'flex h-8 w-full appearance-none rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1 pr-8 text-sm text-[var(--text-primary)] transition-colors',
              'focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-[var(--accent)]',
              'disabled:pointer-events-none disabled:opacity-50',
              className
            )}
            {...props}
          >
            {children}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-secondary)]"
          />
        </div>
      </div>
    )
  }
)

Select.displayName = 'Select'
