import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "DonutWager - Minecraft SMP Gambling",
  description: "The premier Minecraft gambling platform. Play Slots, Crash, Roulette and more.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-darkBg text-white min-h-screen`}>
        <nav className="w-full p-6 border-b border-gray-800 flex justify-between items-center bg-black/50 backdrop-blur-md sticky top-0 z-50">
          <div className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-donutPink to-donutBrown">
            DONUT<span className="text-white">WAGER</span>
          </div>
          <div className="flex gap-4">
            <button className="px-4 py-2 rounded-lg font-medium hover:bg-white/10 transition">Login</button>
            <button className="px-4 py-2 bg-donutPink hover:bg-pink-500 text-white rounded-lg font-bold shadow-[0_0_15px_rgba(255,105,180,0.5)] transition">Deposit</button>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
