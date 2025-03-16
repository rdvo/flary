"use client"

import { useState, useEffect } from "react"
import OpenWorldGame from "./game"

export default function GameManager() {
  const [isLoading, setIsLoading] = useState(true)
  const [hasStarted, setHasStarted] = useState(false)

  useEffect(() => {
    // Simulate loading assets
    const timer = setTimeout(() => {
      setIsLoading(false)
    }, 1500)

    return () => clearTimeout(timer)
  }, [])

  if (isLoading) {
    return (
      <div className="w-full h-screen flex flex-col items-center justify-center bg-black">
        <div className="text-4xl font-bold text-white mb-4">Loading Game...</div>
        <div className="w-64 h-2 bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 animate-[loading_1.5s_ease-in-out_infinite]" />
        </div>
      </div>
    )
  }

  if (!hasStarted) {
    return (
      <div className="w-full h-screen flex flex-col items-center justify-center bg-gradient-to-b from-blue-900 to-black">
        <div className="text-6xl font-bold text-white mb-8 animate-pulse">Open World</div>
        <div className="text-xl text-gray-300 mb-12 max-w-md text-center">
          Explore a vast open world with dynamic characters and environments
        </div>
        <button
          className="px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition-colors"
          onClick={() => setHasStarted(true)}
        >
          Start Game
        </button>
      </div>
    )
  }

  return <OpenWorldGame />
}

