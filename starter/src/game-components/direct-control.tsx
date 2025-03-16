import { useState, useRef, Suspense, useEffect } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { Html, Sky, useKeyboardControls } from "@react-three/drei"
import { Physics, RigidBody, BallCollider } from "@react-three/rapier"
import { Vector3, Quaternion, Euler } from "three"
import { create } from "zustand"
import { KeyboardControls } from "@react-three/drei"

// Game state management
interface GameState {
  health: number
  stamina: number
}

const useGameStore = create<GameState>(() => ({
  health: 100,
  stamina: 100,
}))

// Character controller
function Character({ position = [0, 2, 0] }) {
  const characterRef = useRef(null)
  const modelRef = useRef(null)
  const [subscribeKeys, getKeys] = useKeyboardControls()
  const { camera } = useThree()

  // Camera follow settings
  const cameraOffset = useRef(new Vector3(0, 3, 8))
  const cameraLookAt = useRef(new Vector3(0, 1, 0))
  const characterPosition = useRef(new Vector3(0, 2, 0))

  // Character movement settings
  const walkSpeed = 5
  const turnSpeed = 10

  // Debug state
  const [debugInfo, setDebugInfo] = useState({
    forward: false,
    backward: false,
    left: false,
    right: false,
    dirX: 0,
    dirZ: 0,
  })

  // Initialize camera position
  useEffect(() => {
    if (characterPosition.current) {
      const idealPosition = new Vector3().copy(characterPosition.current).add(cameraOffset.current)
      camera.position.copy(idealPosition)
      camera.lookAt(characterPosition.current)
    }
  }, [camera])

  useFrame((state, delta) => {
    if (!characterRef.current || !modelRef.current) return

    // Get keyboard input
    const { forward, backward, left, right, jump } = getKeys()

    // Update debug info
    setDebugInfo({
      forward,
      backward,
      left,
      right,
      dirX: 0,
      dirZ: 0,
    })

    // Calculate movement direction
    const direction = new Vector3(0, 0, 0)

    // Get current position
    const position = characterRef.current.translation()
    characterPosition.current.set(position.x, position.y, position.z)

    // Update camera position
    const idealPosition = new Vector3().copy(characterPosition.current).add(cameraOffset.current)
    camera.position.lerp(idealPosition, 0.1)

    // Make camera look at character
    cameraLookAt.current.copy(characterPosition.current)
    cameraLookAt.current.y += 1 // Look slightly above character
    camera.lookAt(cameraLookAt.current)

    // Calculate forward and right vectors
    const forward_vector = new Vector3(0, 0, -1)
    const right_vector = new Vector3(1, 0, 0)

    // Apply movement based on input
    if (forward) direction.z = -1
    if (backward) direction.z = 1
    if (left) direction.x = -1
    if (right) direction.x = 1

    // Update debug info with direction
    setDebugInfo((prev) => ({
      ...prev,
      dirX: direction.x,
      dirZ: direction.z,
    }))

    // Normalize direction and apply speed
    if (direction.length() > 0) {
      direction.normalize().multiplyScalar(walkSpeed)

      // Rotate model to face movement direction
      if (direction.z !== 0 || direction.x !== 0) {
        const targetRotation = new Quaternion().setFromEuler(new Euler(0, Math.atan2(direction.x, direction.z), 0))
        modelRef.current.quaternion.slerp(targetRotation, turnSpeed * delta)
      }

      // Apply movement force
      characterRef.current.setLinvel({
        x: direction.x,
        y: characterRef.current.linvel().y, // Preserve vertical velocity
        z: direction.z,
      })
    } else {
      // Apply friction when not moving
      characterRef.current.setLinvel({
        x: 0,
        y: characterRef.current.linvel().y,
        z: 0,
      })
    }

    // Handle jumping
    if (jump && Math.abs(characterRef.current.linvel().y) < 0.1) {
      characterRef.current.setLinvel({
        x: characterRef.current.linvel().x,
        y: 5, // Jump force
        z: characterRef.current.linvel().z,
      })
    }
  })

  return (
    <>
      <RigidBody
        ref={characterRef}
        position={position}
        type="dynamic"
        colliders={false}
        mass={1}
        lockRotations
        enabledRotations={[false, false, false]}
      >
        <BallCollider args={[0.5]} />
        <group ref={modelRef}>
          {/* Temporary character model */}
          <mesh castShadow>
            <capsuleGeometry args={[0.5, 1, 4, 8]} />
            <meshStandardMaterial color="#3366ff" />
          </mesh>
          <mesh position={[0, 0.8, 0.3]} castShadow>
            <boxGeometry args={[0.4, 0.2, 0.4]} />
            <meshStandardMaterial color="#333333" />
          </mesh>
        </group>
      </RigidBody>

      {/* Debug info */}
      <Html position={[0, 5, 0]}>
        <div className="bg-black/70 text-white p-2 rounded text-xs" style={{ width: "200px" }}>
          <div>Forward: {debugInfo.forward ? "Yes" : "No"}</div>
          <div>Backward: {debugInfo.backward ? "Yes" : "No"}</div>
          <div>Left: {debugInfo.left ? "Yes" : "No"}</div>
          <div>Right: {debugInfo.right ? "Yes" : "No"}</div>
          <div>Direction X: {debugInfo.dirX.toFixed(2)}</div>
          <div>Direction Z: {debugInfo.dirZ.toFixed(2)}</div>
        </div>
      </Html>
    </>
  )
}

// World environment
function World() {
  return (
    <>
      {/* Ground */}
      <RigidBody type="fixed" name="ground">
        <mesh receiveShadow rotation-x={-Math.PI / 2} position={[0, 0, 0]}>
          <planeGeometry args={[100, 100]} />
          <meshStandardMaterial color="#88aa88" />
        </mesh>
      </RigidBody>

      {/* Buildings */}
      <RigidBody type="fixed" position={[10, 3, 10]} colliders="cuboid">
        <mesh castShadow receiveShadow>
          <boxGeometry args={[6, 6, 6]} />
          <meshStandardMaterial color="#a0a0a0" />
        </mesh>
      </RigidBody>
    </>
  )
}

// Main game component
export default function DirectControl() {
  return (
    <div className="w-full h-screen">
      <KeyboardControls
        map={[
          { name: "forward", keys: ["ArrowUp", "w", "W"] },
          { name: "backward", keys: ["ArrowDown", "s", "S"] },
          { name: "left", keys: ["ArrowLeft", "a", "A"] },
          { name: "right", keys: ["ArrowRight", "d", "D"] },
          { name: "jump", keys: ["Space"] },
        ]}
      >
        <Canvas shadows camera={{ position: [0, 5, 10], fov: 60 }}>
          <Sky sunPosition={[100, 20, 100]} />
          <ambientLight intensity={0.5} />
          <directionalLight position={[10, 10, 10]} intensity={1} castShadow />

          <Physics debug={false}>
            <Suspense fallback={null}>
              <Character position={[0, 2, 0]} />
              <World />
            </Suspense>
          </Physics>
        </Canvas>
      </KeyboardControls>
      <div className="absolute top-0 left-0 right-0 p-4 text-center text-white bg-black/50 pointer-events-none">
        <h2 className="text-xl font-bold mb-2">Direct Control Mode</h2>
        <p>W/S: Move forward/backward</p>
        <p>A/D: Move left/right</p>
        <p>Space: Jump</p>
      </div>
    </div>
  )
}

