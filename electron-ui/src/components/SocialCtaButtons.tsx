import { Youtube } from 'lucide-react'
import { openExternalUrl } from '../utils/openExternalUrl'
import { SOCIAL_TELEGRAM_URL, SOCIAL_YOUTUBE_URL } from '../config/socialLinks'

function IconTelegram({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.563 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.5 1.201-.82 1.23-.697.064-1.226-.461-1.901-.903-1.056-.692-1.653-1.124-2.678-1.8-1.185-.781-.417-1.21.258-1.911.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.248-.024c-.106.024-1.793 1.139-5.062 3.345-.479.329-.913.489-1.302.481-.428-.008-1.252-.241-1.865-.44-.752-.244-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635.099-.002.321.023.465.14.121.099.154.232.17.326.015.092.034.298.019.46z" />
    </svg>
  )
}

const baseBtn =
  'group relative flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 sm:px-3 text-[11px] sm:text-xs font-semibold text-white shadow-md overflow-hidden ' +
  'bg-[length:220%_100%] animate-shimmer-bg ' +
  'transition-transform duration-200 hover:scale-[1.04] active:scale-[0.97] ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-dark-800 ' +
  'border border-white/10'

export default function SocialCtaButtons({ className = '' }: { className?: string }) {
  return (
    <div className={'flex items-center gap-1.5 sm:gap-2 shrink-0 ' + className}>
      <span className="sr-only">Rudy vs Web3 — Telegram и YouTube</span>
      <button
        type="button"
        onClick={() => openExternalUrl(SOCIAL_TELEGRAM_URL)}
        title="Rudy vs Web3 — Telegram"
        className={
          baseBtn +
          ' focus-visible:ring-cyan-400 ' +
          'bg-gradient-to-r from-[#0088cc] via-[#5ecfff] to-[#0088cc] ' +
          'shadow-[0_0_20px_rgba(0,136,204,0.35)] hover:shadow-[0_0_26px_rgba(94,207,255,0.45)]'
        }
      >
        <span
          className="pointer-events-none absolute inset-0 opacity-40 bg-gradient-to-tr from-white/0 via-white/30 to-white/0 translate-x-[-100%] animate-shimmer-sheen"
          aria-hidden
        />
        <IconTelegram className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0 relative z-[1]" />
        <span className="relative z-[1] hidden min-[380px]:inline whitespace-nowrap">Rudy vs Web3</span>
      </button>
      <button
        type="button"
        onClick={() => openExternalUrl(SOCIAL_YOUTUBE_URL)}
        title="Rudy vs Web3 — YouTube"
        className={
          baseBtn +
          ' focus-visible:ring-red-400 ' +
          'bg-gradient-to-r from-[#c00] via-[#ff4444] to-[#c00] ' +
          'shadow-[0_0_20px_rgba(204,0,0,0.35)] hover:shadow-[0_0_26px_rgba(255,80,80,0.45)]'
        }
      >
        <span
          className="pointer-events-none absolute inset-0 opacity-35 bg-gradient-to-tr from-white/0 via-white/35 to-white/0 translate-x-[-100%] animate-shimmer-sheen"
          aria-hidden
        />
        <Youtube className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0 relative z-[1]" strokeWidth={2.2} />
        <span className="relative z-[1] hidden min-[380px]:inline whitespace-nowrap">Rudy vs Web3</span>
      </button>
    </div>
  )
}
