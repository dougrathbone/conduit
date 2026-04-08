import React from 'react'
import { cn } from '@renderer/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          'flex h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-0 focus:border-[var(--accent)]',
          'disabled:pointer-events-none disabled:opacity-50',
          className
        )}
        {...props}
      />
    )
  }
)

Input.displayName = 'Input'
