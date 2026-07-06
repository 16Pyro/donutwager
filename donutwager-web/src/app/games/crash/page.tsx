"use client"
import { useState, useEffect } from "react"

export default function CrashPage() {
  const [multiplier, setMultiplier] = useState(1.0);
  const [gameState, setGameState] = useState<'IDLE' | 'PLAYING' | 'CRASHED'>('IDLE');
  
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (gameState === 'PLAYING') {
      interval = setInterval(() => {
        setMultiplier(prev => {
          const newMult = prev + (prev * 0.05);
          // Random crash logic (highly simplified)
          if (Math.random() < 0.03 && newMult > 1.2) {
            setGameState('CRASHED');
            clearInterval(interval);
          }
          return newMult;
        });
      }, 100);
    }
    return () => clearInterval(interval);
  }, [gameState]);

  const startGame = () => {
    setMultiplier(1.0);
    setGameState('PLAYING');
  }

  return (
    <div className="min-h-screen p-10 lg:p-24 bg-darkBg text-white flex flex-col items-center">
      <h1 className="text-5xl font-black mb-12 text-transparent bg-clip-text bg-gradient-to-r from-neonAccent to-blue-500">
        Crash
      </h1>

      <div className="w-full max-w-4xl bg-cardBg rounded-3xl border-4 border-gray-800 p-8 shadow-2xl relative overflow-hidden">
         {/* Graph Area */}
         <div className={`h-80 w-full rounded-2xl flex items-center justify-center border border-gray-700 transition-colors ${gameState === 'CRASHED' ? 'bg-red-900/20 border-red-500/50' : 'bg-black/50'}`}>
            <h2 className={`text-7xl font-black font-mono transition-colors ${gameState === 'CRASHED' ? 'text-red-500' : 'text-neonAccent'}`}>
              {multiplier.toFixed(2)}x
            </h2>
            {gameState === 'CRASHED' && (
              <p className="absolute top-1/4 text-red-500 font-bold text-2xl animate-pulse">CRASHED!</p>
            )}
         </div>

         {/* Controls */}
         <div className="mt-8 flex justify-between items-center bg-black/40 p-6 rounded-2xl border border-gray-800">
            <div>
               <p className="text-gray-400 text-sm mb-1">Bet Amount</p>
               <input type="number" defaultValue={10} className="bg-black border border-gray-700 rounded-lg px-4 py-2 text-xl font-bold w-32 focus:outline-none focus:border-neonAccent" />
            </div>

            {gameState === 'IDLE' || gameState === 'CRASHED' ? (
              <button 
                onClick={startGame}
                className="px-12 py-4 bg-neonAccent text-black rounded-xl font-black text-xl hover:scale-105 transition-transform shadow-[0_0_15px_rgba(0,255,204,0.4)]"
              >
                Place Bet
              </button>
            ) : (
              <button 
                onClick={() => setGameState('IDLE')} // Cash out logic would go here
                className="px-12 py-4 bg-donutPink text-white rounded-xl font-black text-xl hover:scale-105 transition-transform shadow-[0_0_15px_rgba(255,105,180,0.4)]"
              >
                Cash Out
              </button>
            )}
         </div>
      </div>
    </div>
  )
}
