import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export default function SettingsCategory({
  title,
  subtitle,
  iconSlot,
  open,
  onToggle,
  children,
}: {
  title: string
  subtitle: string
  iconSlot: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="bg-dark-800 border border-dark-600 rounded-xl overflow-hidden transition-colors hover:border-dark-500/60">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 text-left transition-colors hover:bg-dark-700/35"
      >
        <div className="shrink-0">{iconSlot}</div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
          <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">{subtitle}</p>
        </div>
        <ChevronDown
          className={`w-5 h-5 shrink-0 text-gray-500 transition-transform duration-300 ease-out ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      >
        <div className="overflow-hidden min-h-0">
          <div className="px-4 pb-5 pt-0 border-t border-dark-600/50 space-y-3">{children}</div>
        </div>
      </div>
    </div>
  )
}
