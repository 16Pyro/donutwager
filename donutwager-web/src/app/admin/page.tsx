export default function AdminDashboard() {
  return (
    <div className="min-h-screen p-10 bg-darkBg text-white flex">
      {/* Sidebar */}
      <div className="w-64 bg-cardBg border-r border-gray-800 p-6 hidden md:block">
         <h2 className="text-xl font-black mb-8 text-neonAccent">Admin Panel</h2>
         <ul className="space-y-4">
           <li className="font-bold text-donutPink cursor-pointer">Dashboard</li>
           <li className="text-gray-400 hover:text-white cursor-pointer transition">Users</li>
           <li className="text-gray-400 hover:text-white cursor-pointer transition flex justify-between">Withdrawals <span className="bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">3</span></li>
           <li className="text-gray-400 hover:text-white cursor-pointer transition">Game Stats</li>
         </ul>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-10">
        <h1 className="text-3xl font-black mb-8">Platform Overview</h1>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
          <div className="bg-cardBg p-6 rounded-xl border border-gray-800">
             <p className="text-gray-400 text-sm">Total Wagered (24h)</p>
             <p className="text-3xl font-black text-green-400">$45,230.50</p>
          </div>
          <div className="bg-cardBg p-6 rounded-xl border border-gray-800">
             <p className="text-gray-400 text-sm">Active Players</p>
             <p className="text-3xl font-black text-blue-400">128</p>
          </div>
          <div className="bg-cardBg p-6 rounded-xl border border-gray-800">
             <p className="text-gray-400 text-sm">Pending Withdrawals</p>
             <p className="text-3xl font-black text-red-400">$3,400.00</p>
          </div>
        </div>

        <h2 className="text-2xl font-bold mb-6">Withdrawal Queue</h2>
        <div className="bg-cardBg rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-black/50 text-gray-400 border-b border-gray-700">
                <th className="py-4 px-6">User</th>
                <th className="py-4 px-6">Method</th>
                <th className="py-4 px-6">Amount</th>
                <th className="py-4 px-6">Action</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-800/50">
                <td className="py-4 px-6 font-medium">cook45_mc</td>
                <td className="py-4 px-6">Solana</td>
                <td className="py-4 px-6 font-bold text-red-400">$1,500.00</td>
                <td className="py-4 px-6">
                  <div className="flex gap-2">
                    <button className="px-3 py-1 bg-green-500/20 text-green-400 rounded-lg hover:bg-green-500/40 transition">Approve</button>
                    <button className="px-3 py-1 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/40 transition">Reject</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
