export default function WalletPage() {
  return (
    <div className="min-h-screen p-10 lg:p-24 bg-darkBg text-white flex flex-col items-center">
      <div className="w-full max-w-4xl bg-cardBg rounded-2xl border border-gray-800 p-8 shadow-2xl">
        <h1 className="text-4xl font-black mb-8 border-b border-gray-800 pb-4">My Wallet</h1>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
          <div className="bg-black/40 p-6 rounded-xl border border-gray-700 relative overflow-hidden">
             <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-donutPink to-neonAccent"></div>
             <p className="text-gray-400 font-medium mb-2">Available Balance</p>
             <p className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-green-400 to-green-600">
               $1,337.00
             </p>
             <p className="text-sm text-gray-500 mt-2">Synced with Minecraft: <span className="text-neonAccent">Yes</span></p>
          </div>

          <div className="flex flex-col gap-4">
             <button className="w-full py-4 bg-donutPink hover:bg-pink-500 rounded-xl font-bold text-lg shadow-[0_0_15px_rgba(255,105,180,0.5)] transition-all transform hover:scale-[1.02]">
                Deposit (Stripe/Crypto)
             </button>
             <button className="w-full py-4 bg-transparent border-2 border-gray-600 hover:border-gray-400 rounded-xl font-bold text-lg transition-all transform hover:scale-[1.02]">
                Withdraw
             </button>
          </div>
        </div>

        <h2 className="text-2xl font-bold mb-4">Transaction History</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-700 text-gray-400">
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Amount</th>
                <th className="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-800/50 hover:bg-white/5 transition-colors">
                <td className="py-4 px-4 font-mono text-sm">2026-07-01</td>
                <td className="py-4 px-4">Deposit (SOL)</td>
                <td className="py-4 px-4 text-green-400 font-bold">+$50.00</td>
                <td className="py-4 px-4"><span className="px-2 py-1 bg-green-500/20 text-green-400 rounded-full text-xs font-bold">Completed</span></td>
              </tr>
              <tr className="border-b border-gray-800/50 hover:bg-white/5 transition-colors">
                <td className="py-4 px-4 font-mono text-sm">2026-06-30</td>
                <td className="py-4 px-4">Withdraw (PayPal)</td>
                <td className="py-4 px-4 text-red-400 font-bold">-$100.00</td>
                <td className="py-4 px-4"><span className="px-2 py-1 bg-yellow-500/20 text-yellow-400 rounded-full text-xs font-bold">Pending Approval</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
