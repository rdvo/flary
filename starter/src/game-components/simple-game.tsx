"use client"

import { useState, useRef, Suspense, useEffect } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { Html, Sky, useKeyboardControls } from "@react-three/drei"
import { Physics, RigidBody, BallCollider } from "@react-three/rapier"
import { Vector3, Quaternion, Euler, MathUtils } from "three"
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

// Mouse controls for camera
function MouseControls() {
  const { camera } = useThree()
  const mouseRef = useRef({ x: 0, y: 0, isDragging: false })
  const targetRotationRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const handleMouseDown = (e) => {
      mouseRef.current.isDragging = true
      mouseRef.current.x = e.clientX
      mouseRef.current.y = e.clientY
    }

    const handleMouseUp = () => {
      mouseRef.current.isDragging = false
    }

    const handleMouseMove = (e) => {
      if (mouseRef.current.isDragging) {
        // Calculate mouse movement
        const deltaX = e.clientX - mouseRef.current.x
        const deltaY = e.clientY - mouseRef.current.y

        // Update target rotation
        targetRotationRef.current.y -= deltaX * 0.01
        targetRotationRef.current.x -= deltaY * 0.01

        // Clamp vertical rotation to prevent flipping
        targetRotationRef.current.x = MathUtils.clamp(
          targetRotationRef.current.x,
          -Math.PI / 3, // Look down limit
          Math.PI / 3, // Look up limit
        )

        // Update mouse position
        mouseRef.current.x = e.clientX
        mouseRef.current.y = e.clientY
      }
    }

    // Add event listeners
    document.addEventListener("mousedown", handleMouseDown)
    document.addEventListener("mouseup", handleMouseUp)
    document.addEventListener("mousemove", handleMouseMove)

    // Remove event listeners on cleanup
    return () => {
      document.removeEventListener("mousedown", handleMouseDown)
      document.removeEventListener("mouseup", handleMouseUp)
      document.removeEventListener("mousemove", handleMouseMove)
    }
  }, [])

  return { targetRotation: targetRotationRef.current }
}

// Character controller
function Character({ position = [0, 2, 0] }) {
  const characterRef = useRef(null)
  const modelRef = useRef(null)
  const [subscribeKeys, getKeys] = useKeyboardControls()
  const { camera } = useThree()
  const { targetRotation } = MouseControls()

  // Camera follow settings
  const cameraDistance = 8
  const cameraHeight = 3
  const cameraOffset = useRef(new Vector3(0, cameraHeight, cameraDistance))
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

    // Update camera based on mouse rotation
    const cameraAngleY = targetRotation.y

    // Calculate camera position based on rotation around character
    cameraOffset.current.x = Math.sin(cameraAngleY) * cameraDistance
    cameraOffset.current.z = Math.cos(cameraAngleY) * cameraDistance

    const idealPosition = new Vector3().copy(characterPosition.current).add(cameraOffset.current)
    camera.position.lerp(idealPosition, 0.1)

    // Make camera look at character with vertical rotation
    cameraLookAt.current.copy(characterPosition.current)
    cameraLookAt.current.y += 1 // Look slightly above character
    camera.lookAt(cameraLookAt.current)

    // Apply vertical rotation
    camera.rotation.x += targetRotation.x * 0.1

    // Calculate forward and right vectors based on camera
    const forward_vector = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    forward_vector.y = 0 // Keep movement on the horizontal plane
    forward_vector.normalize()

    const right_vector = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
    right_vector.y = 0
    right_vector.normalize()

    // Apply movement based on input
    if (forward) direction.add(forward_vector)
    if (backward) direction.sub(forward_vector)
    if (left) direction.sub(right_vector)
    if (right) direction.add(right_vector)

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
      const targetRotation = new Quaternion().setFromEuler(new Euler(0, Math.atan2(direction.x, direction.z), 0))
      modelRef.current.quaternion.slerp(targetRotation, turnSpeed * delta)

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

// Building component
function Building({ position, size, color = "#cccccc" }) {
  return (
    <RigidBody type="fixed" position={position} colliders="cuboid">
      <mesh castShadow receiveShadow>
        <boxGeometry args={size} />
        <meshStandardMaterial color={color} />
      </mesh>
    </RigidBody>
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
      <Building position={[10, 3, 10]} size={[6, 6, 6]} color="#a0a0a0" />
      <Building position={[-10, 2, -10]} size={[4, 4, 4]} color="#9090a0" />
      <Building position={[15, 4, -15]} size={[8, 8, 8]} color="#b0b0b0" />
      <Building position={[-15, 3, 15]} size={[6, 6, 6]} color="#c0c0c0" />

      {/* Roads */}
      <mesh receiveShadow rotation-x={-Math.PI / 2} position={[0, 0.01, 0]}>
        <planeGeometry args={[8, 100]} />
        <meshStandardMaterial color="#333333" />
      </mesh>
      <mesh receiveShadow rotation-x={-Math.PI / 2} position={[0, 0.01, 0]}>
        <planeGeometry args={[100, 8]} />
        <meshStandardMaterial color="#333333" />
      </mesh>
    </>
  )
}

// HUD component
function HUD() {
  const health = useGameStore((state) => state.health)
  const stamina = useGameStore((state) => state.stamina)

  return (
    <Html fullscreen>
      <div className="absolute bottom-5 left-5 right-5 flex flex-col gap-2 pointer-events-none">
        <div className="flex items-center gap-2">
          <div className="text-white font-bold">Health</div>
          <div className="w-48 h-4 bg-black/50 rounded-full overflow-hidden">
            <div className="h-full bg-red-500 rounded-full" style={{ width: `${health}%` }} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-white font-bold">Stamina</div>
          <div className="w-48 h-4 bg-black/50 rounded-full overflow-hidden">
            <div className="h-full bg-yellow-500 rounded-full" style={{ width: `${stamina}%` }} />
          </div>
        </div>
        <div className="mt-2 text-white text-sm">WASD: Move | SPACE: Jump | Mouse: Look</div>
      </div>
    </Html>
  )
}

// Instructions overlay
function Instructions() {
  return (
    <div className="absolute top-0 left-0 right-0 p-4 text-center text-white bg-black/50 pointer-events-none">
      <h2 className="text-xl font-bold mb-2">Controls</h2>
      <p>Click and drag mouse to look around</p>
      <p>W/S: Move forward/backward</p>
      <p>A/D: Strafe left/right</p>
      <p>Space: Jump</p>
    </div>
  )
}

// Main game component
export default function SimpleGame() {
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
          <directionalLight
            position={[10, 10, 10]}
            intensity={1}
            castShadow
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
          />

          <Physics debug={false}>
            <Suspense fallback={null}>
              <Character position={[0, 2, 0]} />
              <World />
              <HUD />
            </Suspense>
          </Physics>
        </Canvas>
      </KeyboardControls>
      <Instructions />
    </div>
  )
}

