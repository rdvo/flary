import { Canvas } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"

export default function BasicScene() {
  return (
    <div className="w-full h-screen">
      <Canvas>
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 10, 5]} intensity={1} />
        <mesh>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="orange" />
        </mesh>
        <OrbitControls />
      </Canvas>
    </div>
  )
}

