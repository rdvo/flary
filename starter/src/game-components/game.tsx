import { useState, useRef, useEffect, Suspense } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { Html, Sky, useKeyboardControls } from "@react-three/drei"
import { Physics, RigidBody, BallCollider, type RapierRigidBody, useRapier } from "@react-three/rapier"
import { Vector3, Quaternion, Euler } from "three"
import type * as THREE from "three"
import { create } from "zustand"
import { KeyboardControls } from "@react-three/drei"

// Game state management
interface GameState {
  health: number
  stamina: number
  setHealth: (health: number) => void
  setStamina: (stamina: number) => void
  decreaseStamina: () => void
  regenerateStamina: () => void
}

const useGameStore = create<GameState>((set) => ({
  health: 100,
  stamina: 100,
  setHealth: (health) => set({ health }),
  setStamina: (stamina) => set({ stamina }),
  decreaseStamina: () => set((state) => ({ stamina: Math.max(0, state.stamina - 1) })),
  regenerateStamina: () => set((state) => ({ stamina: Math.min(100, state.stamina + 0.2) })),
}))

// Character controller
function Character({ position = [0, 2, 0] }) {
  const characterRef = useRef<RapierRigidBody>(null)
  const modelRef = useRef<THREE.Group>(null)
  const [subscribeKeys, getKeys] = useKeyboardControls()
  const { camera } = useThree()
  const { rapier, world } = useRapier()
  const decreaseStamina = useGameStore((state) => state.decreaseStamina)
  const regenerateStamina = useGameStore((state) => state.regenerateStamina)
  const stamina = useGameStore((state) => state.stamina)

  // Character movement state
  const [movement, setMovement] = useState({
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
  })

  // Camera follow settings
  const cameraOffset = new Vector3(0, 2, 5)
  const cameraLookAt = new Vector3(0, 1, 0)
  const cameraPosition = new Vector3()
  const characterPosition = new Vector3()

  // Character movement settings
  const walkSpeed = 3
  const sprintSpeed = 6
  const jumpForce = 5
  const turnSpeed = 10

  // Character state
  const [isGrounded, setIsGrounded] = useState(true)
  const [isMoving, setIsMoving] = useState(false)
  const [isSprinting, setIsSprinting] = useState(false)

  // Ground check using raycasting
  const checkGroundContact = () => {
    if (!characterRef.current || !world) return false

    const origin = characterRef.current.translation()

    // Start ray slightly above the character's bottom
    origin.y -= 0.4

    const direction = { x: 0, y: -1, z: 0 }
    const ray = new rapier.Ray({ x: origin.x, y: origin.y, z: origin.z }, direction)
    const hit = world.castRay(ray, 0.6, true)

    return hit !== null
  }

  useFrame((state, delta) => {
    if (!characterRef.current || !modelRef.current) return

    // Get keyboard input
    const { forward, backward, left, right, jump, shift } = getKeys()

    // Update movement state
    setMovement({
      forward,
      backward,
      left,
      right,
      jump,
      sprint: shift && stamina > 0,
    })

    // Calculate movement direction
    const direction = new Vector3(0, 0, 0)
    const speed = shift && stamina > 0 ? sprintSpeed : walkSpeed

    // Handle sprinting and stamina
    if (shift && (forward || backward || left || right)) {
      if (stamina > 0) {
        setIsSprinting(true)
        decreaseStamina()
      } else {
        setIsSprinting(false)
      }
    } else {
      setIsSprinting(false)
      regenerateStamina()
    }

    // Get character position and rotation
    characterPosition.copy(characterRef.current.translation())

    // Calculate camera position
    const cameraIdealPosition = new Vector3()
    cameraIdealPosition.copy(characterPosition).add(cameraOffset)

    // Smooth camera follow
    camera.position.lerp(cameraIdealPosition, 0.1)

    // Camera look at character
    cameraLookAt.copy(characterPosition)
    cameraLookAt.y += 1
    camera.lookAt(cameraLookAt)

    // Calculate movement direction relative to camera
    const cameraDirection = new Vector3()
    camera.getWorldDirection(cameraDirection)
    cameraDirection.y = 0
    cameraDirection.normalize()

    const cameraRight = new Vector3(cameraDirection.z, 0, -cameraDirection.x)

    if (forward) direction.add(cameraDirection)
    if (backward) direction.sub(cameraDirection)
    if (left) direction.sub(cameraRight)
    if (right) direction.add(cameraRight)

    // Normalize direction and apply speed
    if (direction.length() > 0) {
      direction.normalize().multiplyScalar(speed * delta)
      setIsMoving(true)

      // Rotate model to face movement direction
      const targetRotation = new Quaternion().setFromEuler(new Euler(0, Math.atan2(direction.x, direction.z), 0))
      modelRef.current.quaternion.slerp(targetRotation, turnSpeed * delta)
    } else {
      setIsMoving(false)
    }

    // Apply movement
    if (direction.length() > 0) {
      characterRef.current.setLinvel({
        x: direction.x * 50,
        y: characterRef.current.linvel().y,
        z: direction.z * 50,
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
    if (jump && isGrounded) {
      characterRef.current.setLinvel({
        x: characterRef.current.linvel().x,
        y: jumpForce,
        z: characterRef.current.linvel().z,
      })
      setIsGrounded(false)
    }

    // Check if we're falling
    if (!isGrounded && characterRef.current.linvel().y < 0) {
      const isOnGround = checkGroundContact()
      if (isOnGround) {
        setIsGrounded(true)
      }
    }

    // Update grounded state
    setIsGrounded(checkGroundContact())
  })

  // Ground detection
  useEffect(() => {
    const interval = setInterval(() => {
      if (characterRef.current) {
        const isOnGround = checkGroundContact()
        if (isOnGround) {
          setIsGrounded(true)
        }
      }
    }, 100)

    return () => {
      clearInterval(interval)
    }
  }, [])

  return (
    <RigidBody
      ref={characterRef}
      position={position}
      enabledRotations={[false, false, false]}
      lockRotations
      mass={1}
      type="dynamic"
      colliders={false}
    >
      <BallCollider args={[0.5]} />
      <group ref={modelRef}>
        {/* Temporary character model - will be replaced with proper model later */}
        <mesh castShadow>
          <capsuleGeometry args={[0.5, 1, 4, 8]} />
          <meshStandardMaterial color={isSprinting ? "#ff9900" : "#3366ff"} />
        </mesh>
        <mesh position={[0, 0.8, 0.3]} castShadow>
          <boxGeometry args={[0.4, 0.2, 0.4]} />
          <meshStandardMaterial color="#333333" />
        </mesh>
      </group>
    </RigidBody>
  )
}

// NPC character
function NPC({ position = [0, 1, 0], color = "#ff0000", patrolPoints = [] }) {
  const npcRef = useRef<RapierRigidBody>(null)
  const modelRef = useRef<THREE.Group>(null)
  const [currentPoint, setCurrentPoint] = useState(0)
  const [waitTimer, setWaitTimer] = useState(0)
  const speed = 1.5

  useFrame((state, delta) => {
    if (!npcRef.current || !modelRef.current || patrolPoints.length === 0) return

    const npcPosition = new Vector3()
    npcPosition.copy(npcRef.current.translation())

    // Simple patrol AI
    if (waitTimer > 0) {
      setWaitTimer(waitTimer - delta)
      return
    }

    const target = new Vector3(...patrolPoints[currentPoint])
    const direction = new Vector3().subVectors(target, npcPosition)
    direction.y = 0

    // If close to target, move to next point
    if (direction.length() < 0.5) {
      setCurrentPoint((currentPoint + 1) % patrolPoints.length)
      setWaitTimer(Math.random() * 2 + 1) // Wait 1-3 seconds at each point
      return
    }

    // Move towards target
    direction.normalize().multiplyScalar(speed * delta)

    // Rotate model to face movement direction
    const targetRotation = new Quaternion().setFromEuler(new Euler(0, Math.atan2(direction.x, direction.z), 0))
    modelRef.current.quaternion.slerp(targetRotation, 5 * delta)

    // Apply movement
    npcRef.current.setLinvel({
      x: direction.x * 50,
      y: npcRef.current.linvel().y,
      z: direction.z * 50,
    })
  })

  return (
    <RigidBody
      ref={npcRef}
      position={position}
      enabledRotations={[false, false, false]}
      lockRotations
      type="dynamic"
      colliders={false}
    >
      <BallCollider args={[0.5]} />
      <group ref={modelRef}>
        {/* Temporary NPC model */}
        <mesh castShadow>
          <capsuleGeometry args={[0.5, 1, 4, 8]} />
          <meshStandardMaterial color={color} />
        </mesh>
        <mesh position={[0, 0.8, 0.3]} castShadow>
          <boxGeometry args={[0.4, 0.2, 0.4]} />
          <meshStandardMaterial color="#333333" />
        </mesh>
      </group>
    </RigidBody>
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
      <RigidBody type="fixed" name="ground" colliders="cuboid">
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
      <Building position={[0, 5, -20]} size={[10, 10, 10]} color="#d0d0d0" />

      {/* Roads */}
      <mesh receiveShadow rotation-x={-Math.PI / 2} position={[0, 0.01, 0]}>
        <planeGeometry args={[8, 100]} />
        <meshStandardMaterial color="#333333" />
      </mesh>
      <mesh receiveShadow rotation-x={-Math.PI / 2} position={[0, 0.01, 0]}>
        <planeGeometry args={[100, 8]} />
        <meshStandardMaterial color="#333333" />
      </mesh>

      {/* NPCs */}
      <NPC
        position={[5, 1, 5]}
        color="#ff5555"
        patrolPoints={[
          [5, 1, 5],
          [10, 1, 5],
          [10, 1, 10],
          [5, 1, 10],
        ]}
      />
      <NPC
        position={[-5, 1, -5]}
        color="#55ff55"
        patrolPoints={[
          [-5, 1, -5],
          [-10, 1, -5],
          [-10, 1, -10],
          [-5, 1, -10],
        ]}
      />
      <NPC
        position={[5, 1, -5]}
        color="#5555ff"
        patrolPoints={[
          [5, 1, -5],
          [10, 1, -5],
          [10, 1, -10],
          [5, 1, -10],
        ]}
      />
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
        <div className="mt-2 text-white text-sm">WASD: Move | SHIFT: Sprint | SPACE: Jump | MOUSE: Look</div>
      </div>
    </Html>
  )
}

// Main game component
export default function OpenWorldGame() {
  return (
    <div className="w-full h-screen">
      <KeyboardControls
        map={[
          { name: "forward", keys: ["ArrowUp", "w", "W"] },
          { name: "backward", keys: ["ArrowDown", "s", "S"] },
          { name: "left", keys: ["ArrowLeft", "a", "A"] },
          { name: "right", keys: ["ArrowRight", "d", "D"] },
          { name: "jump", keys: ["Space"] },
          { name: "shift", keys: ["ShiftLeft", "ShiftRight"] },
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
            shadow-camera-far={50}
            shadow-camera-left={-20}
            shadow-camera-right={20}
            shadow-camera-top={20}
            shadow-camera-bottom={-20}
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
    </div>
  )
}

