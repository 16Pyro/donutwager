import Image from "next/image";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-start p-10 lg:p-24">
      {/* Hero Section */}
      <div className="text-center mb-20 space-y-6">
        <h1 className="text-5xl lg:text-7xl font-black mb-4">
          Risk it all for the <span className="text-donutPink drop-shadow-[0_0_10px_rgba(255,105,180,0.8)]">Dough</span>
        </h1>
        <p className="text-xl text-gray-400 max-w-2xl mx-auto">
          The ultimate Minecraft SMP gambling platform. Sync your balance seamlessly, deposit crypto or card, and dominate the leaderboard.
        </p>
        <div className="flex justify-center gap-6 mt-8">
          <button className="px-8 py-4 bg-neonAccent text-black font-bold text-lg rounded-xl shadow-[0_0_20px_rgba(0,255,204,0.6)] hover:scale-105 transition-transform">
            Start Playing
          </button>
          <button className="px-8 py-4 bg-cardBg border border-gray-700 text-white font-bold text-lg rounded-xl hover:bg-gray-800 transition-colors">
            View Leaderboard
          </button>
        </div>
      </div>

      {/* Popular Games */}
      <h2 className="text-3xl font-bold mb-10 text-left w-full max-w-6xl">Popular Games</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 w-full max-w-6xl">
        <GameCard title="Crash" color="from-green-500 to-green-700" delay="0" />
        <GameCard title="Slots" color="from-pink-500 to-donutPink" delay="100" />
        <GameCard title="Roulette" color="from-red-500 to-red-700" delay="200" />
        <GameCard title="Coinflip" color="from-yellow-400 to-yellow-600" delay="300" />
      </div>

      {/* Live Feed */}
      <h2 className="text-3xl font-bold mt-20 mb-10 text-left w-full max-w-6xl">Live Bets</h2>
      <div className="w-full max-w-6xl bg-cardBg rounded-xl p-6 border border-gray-800 h-64 overflow-hidden relative">
        <div className="absolute inset-0 bg-gradient-to-t from-cardBg to-transparent z-10 pointer-events-none h-full w-full"></div>
        {/* Placeholder for live feed */}
        <div className="space-y-4 text-sm font-mono text-gray-400">
          <div className="flex justify-between items-center bg-black/40 p-3 rounded">
            <span>Player: cook45</span>
            <span className="text-donutPink">Slots</span>
            <span className="text-green-400">+$50.00</span>
          </div>
          <div className="flex justify-between items-center bg-black/40 p-3 rounded">
            <span>Player: clack</span>
            <span className="text-neonAccent">Crash</span>
            <span className="text-red-400">-$20.00</span>
          </div>
           <div className="flex justify-between items-center bg-black/40 p-3 rounded">
            <span>Player: notch</span>
            <span className="text-yellow-400">Coinflip</span>
            <span className="text-green-400">+$150.00</span>
          </div>
        </div>
      </div>
    </main>
  );
}

function GameCard({ title, color, delay }: { title: string, color: string, delay: string }) {
  return (
    <div className="group relative h-64 rounded-2xl overflow-hidden cursor-pointer transition-transform hover:-translate-y-2">
      <div className={`absolute inset-0 bg-gradient-to-br ${color} opacity-80 group-hover:opacity-100 transition-opacity`}></div>
      <div className="absolute inset-0 bg-black/40"></div>
      <div className="absolute bottom-6 left-6">
        <h3 className="text-2xl font-black text-white drop-shadow-md">{title}</h3>
      </div>
    </div>
  )
}
