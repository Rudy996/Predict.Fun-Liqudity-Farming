import { useState, useEffect } from 'react'
import { X, Eye, EyeOff } from 'lucide-react'

interface ConnectDialogProps {
  onConnect: (data: { api_key: string; predict_account_address: string; privy_wallet_private_key: string; proxy?: string }) => Promise<{ success: boolean; error?: string }>
  onClose: () => void
  savedCredentials?: { api_key?: string; predict_account_address?: string; privy_wallet_private_key?: string; proxy?: string } | null
  /** Показать ошибку при открытии (например после неудачного авто-подключения) */
  bootstrapError?: string
}

export default function ConnectDialog({ onConnect, onClose, savedCredentials, bootstrapError }: ConnectDialogProps) {
  const [apiKey, setApiKey] = useState(savedCredentials?.api_key || '')
  const [address, setAddress] = useState(savedCredentials?.predict_account_address || '')
  const [privyKey, setPrivyKey] = useState(savedCredentials?.privy_wallet_private_key || '')
  const [proxy, setProxy] = useState(savedCredentials?.proxy || '')
  const [showKey, setShowKey] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (bootstrapError) setError(bootstrapError)
  }, [bootstrapError])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!apiKey || !address || !privyKey) { setError('Please fill in all required fields'); return }
    if (!address.startsWith('0x')) { setError('Address must start with 0x'); return }
    setLoading(true)
    setError('')
    try {
      const res = await onConnect({ api_key: apiKey, predict_account_address: address, privy_wallet_private_key: privyKey, proxy: proxy || undefined })
      if (!res.success) setError(res.error || 'Connection failed')
    } catch (err: any) { setError(err.message || 'Connection failed') }
    finally { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fadeIn" onClick={onClose}>
      <div className="w-full max-w-md bg-dark-800 border border-dark-600 rounded-xl animate-slideDown" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-dark-600">
          <h2 className="text-lg font-semibold">Connect</h2>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-200 transition-colors"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div><label className="block text-sm text-gray-400 mb-1">API Key</label>
            <input type="text" value={apiKey} onChange={e => setApiKey(e.target.value)} className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb transition-colors" placeholder="Enter API key" /></div>
          <div><label className="block text-sm text-gray-400 mb-1">Account Address</label>
            <input type="text" value={address} onChange={e => setAddress(e.target.value)} className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb transition-colors font-mono" placeholder="0x..." /></div>
          <div><label className="block text-sm text-gray-400 mb-1">Privy Wallet Private Key</label>
            <div className="relative">
              <input type={showKey ? 'text' : 'password'} value={privyKey} onChange={e => setPrivyKey(e.target.value)} className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 pr-10 text-sm text-gray-100 focus:outline-none focus:border-bnb transition-colors font-mono" placeholder="Enter private key" />
              <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </div></div>
          <div><label className="block text-sm text-gray-400 mb-1">Proxy (optional)</label>
            <input type="text" value={proxy} onChange={e => setProxy(e.target.value)} className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb transition-colors font-mono" placeholder="http://proxy:port" /></div>
          {error && <div className="text-sm text-danger bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">{error}</div>}
          <button type="submit" disabled={loading} className="w-full py-2.5 bg-bnb text-dark-900 rounded-lg text-sm font-semibold hover:bg-bnb-light transition-colors disabled:opacity-50">{loading ? 'Connecting...' : 'Connect'}</button>
        </form>
      </div>
    </div>
  )
}
