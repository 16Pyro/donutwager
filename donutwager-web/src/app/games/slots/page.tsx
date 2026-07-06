"use client"
import { useState } from "react"

export default function SlotsPage() {
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<string[]>(['💎', '7️⃣', '🍩']);

  const symbols = ['💎', '7️⃣', '🍩', '🍒', '🔔'];

  const handleSpin = () => {
    if (spinning) return;
    setSpinning(true);
    
    // Simulate spin API call
    setTimeout(() => {
      setResult([
        symbols[Math.floor(Math.random() * symbols.length)],
        symbols[Math.floor(Math.random() * symbols.length)],
        symbols[Math.floor(Math.random() * symbols.length)]
      ]);
      setSpinning(false);
    }, 2000);
  };

  return (
    <div className="min-h-screen p-10 lg:p-24 bg-darkBg text-white flex flex-col items-center">
      <h1 className="text-5xl font-black mb-12 text-transparent bg-clip-text bg-gradient-to-r from-donutPink to-purple-500">
        Neon Slots
      </h1>

      <div className="bg-cardBg p-8 rounded-3xl border-4 border-gray-800 shadow-[0_0_50px_rgba(255,105,180,0.15)] relative">
         <div className="flex gap-4 mb-8">
            {result.map((symbol, idx) => (
              <div key={idx} className={`w-32 h-32 bg-black border-2 border-gray-700 flex items-center justify-center text-6xl rounded-xl shadow-inner ${spinning ? 'animate-bounce' : ''}`}>
                 {symbol}
              </div>
            ))}
         </div>

         <div className="flex justify-center items-center gap-6">
            <div className="bg-black px-6 py-3 rounded-lg border border-gray-700">
               <p className="text-xs text-gray-500">Bet Amount</p>
               <p className="text-xl font-bold">$10.00</p>
            </div>
            <button 
              onClick={handleSpin}
              disabled={spinning}
              className={`px-12 py-4 rounded-xl font-black text-2xl transition-all transform ${spinning ? 'bg-gray-600 text-gray-400 cursor-not-allowed' : 'bg-neonAccent text-black hover:scale-105 shadow-[0_0_20px_rgba(0,255,204,0.6)] hover:shadow-[0_0_30px_rgba(0,255,204,0.8)]'}`}
            >
              {spinning ? 'SPINNING...' : 'SPIN'}
            </button>
         </div>
      </div>
    </div>
  )
}
