# Claude Code Prompt — Colombo Real-World Driving Simulator

Act as a senior 3D game developer, geospatial engineer, and PlayCanvas specialist.

Build a realistic, browser-based 3D driving simulator using **PlayCanvas Engine** and real-world map data from Colombo, Sri Lanka.

The application must allow users to drive a vehicle through real Colombo streets, following actual road layouts and recognizable locations.

Do not build a generic racing game or fictional city. The primary goal is to recreate the real geography of Colombo as accurately as the available data allows.

## 1. Technology stack

Use:

- PlayCanvas Engine for 3D rendering and game systems.
- TypeScript for maintainable game logic.
- Vite for development and production builds.
- OpenStreetMap (OSM) for real-world geographic data.
- A suitable map tile or vector tile provider for map visualization.
- A vehicle physics system compatible with PlayCanvas.
- WebGL 2 support with WebGPU where available.
- HTML/CSS for the game HUD and menus.

Keep the application modular and production-oriented.

## 2. Real Colombo map

The game must use actual Colombo geographic coordinates and real road geometry.

Initial playable area should include:

- Colombo Fort
- Galle Face Green
- Pettah
- Maradana
- Cinnamon Gardens
- Bambalapitiya
- Kollupitiya
- Wellawatte
- Dehiwala
- Maharagama as a future expansion area

Use real roads and intersections from OpenStreetMap.

Important road examples:

- Galle Road
- Duplication Road
- Baseline Road
- Marine Drive
- Parliament Road
- Union Place
- D. R. Wijewardena Mawatha

Do not manually invent road layouts.

Convert geographic coordinates into a local 3D coordinate system using a suitable projection or local tangent-plane conversion.

Do not use raw latitude and longitude as world-space coordinates.

## 3. Map data architecture

Create a dedicated map data pipeline.

The pipeline should:

1. Retrieve road and building data from a legitimate OSM data source.
2. Parse road geometry, road classifications, intersections, and building footprints.
3. Convert geographic coordinates into local game coordinates.
4. Generate road meshes with correct widths.
5. Generate intersections and junction connections.
6. Generate sidewalks and road markings.
7. Generate basic 3D buildings from building footprints and height tags.
8. Store the processed map in reusable chunks.
9. Load and unload map chunks according to the player's position.

Use a provider abstraction so map sources can be changed later.

Do not scrape map websites or bypass provider restrictions.

Respect tile provider usage policies, attribution requirements, and OpenStreetMap's ODbL requirements.

Display appropriate OpenStreetMap attribution in the game.

## 4. 3D city environment

Create a believable Colombo environment.

Include:

- Asphalt roads
- Road lanes and markings
- Traffic lights
- Sidewalks
- Buildings
- Street lamps
- Trees and vegetation
- Road signs
- Bus stops
- Parking areas
- Coastal scenery near Galle Face
- Tropical Sri Lankan environment

Buildings should use actual OSM footprints where available.

Where building height data is unavailable, use reasonable procedural placeholder heights and clearly treat them as approximations.

Do not claim that every building is an exact real-world replica.

Prioritize recognizable city geography over decorative detail.

## 5. Vehicle system

Create a realistic third-person driving system.

The player should be able to:

- Accelerate
- Brake
- Reverse
- Steer
- Handbrake
- Drive forward and backward
- Rotate the steering wheel
- Control the camera

Vehicle physics should include:

- Acceleration
- Engine torque approximation
- Gear shifting
- Wheel friction
- Suspension
- Steering response
- Braking
- Collision detection
- Vehicle mass
- Speed-dependent steering

Use a proper vehicle physics implementation where possible.

Do not simulate driving by simply moving a car model forward without physics.

Create a configurable vehicle system so different vehicles can be added later.

Start with a Sri Lankan-style sedan or compact car.

## 6. Driving controls

Desktop keyboard controls:

- W / Arrow Up: Accelerate
- S / Arrow Down: Brake or reverse
- A / Arrow Left: Steer left
- D / Arrow Right: Steer right
- Space: Handbrake
- C: Change camera
- R: Reset vehicle
- Escape: Pause

Add mobile touch controls:

- Virtual steering wheel or left/right buttons
- Accelerator pedal
- Brake pedal
- Handbrake
- Camera switch

Controls must work responsively on desktop and mobile browsers.

## 7. Camera system

Implement:

- Third-person chase camera
- First-person cockpit camera
- Hood camera
- Free camera for debugging

The chase camera should smoothly follow the vehicle.

Add camera collision handling so the camera does not pass through buildings or the ground.

## 8. Traffic system

Create a basic AI traffic system using the real road network.

AI vehicles should:

- Follow road lanes
- Stop at traffic lights
- Respect intersections
- Maintain safe distances
- Avoid collisions
- Use realistic speed limits
- Follow left-hand traffic

Sri Lanka drives on the left side of the road. The simulator must correctly implement left-hand traffic.

Add basic traffic lights and junction behavior.

For the first MVP, use a small number of AI vehicles and expand later.

## 9. Navigation system

Create a simple navigation system using the real road network.

Features:

- Select a destination
- Calculate a route
- Display the route on the map
- Show distance to destination
- Show current speed
- Show direction indicators
- Display destination names

Use a suitable routing engine or routing API.

Do not calculate routes by simply drawing a straight line between two points.

## 10. Game interface

Create a clean, modern driving simulator interface.

HUD should display:

- Current speed in km/h
- Gear
- RPM approximation
- Mini-map
- Current street name
- Destination
- Distance remaining
- Camera mode

Design style:

- Dark dashboard
- Minimal UI
- White typography
- Red or orange highlights
- Sharp rectangular panels
- Professional simulator aesthetic

The HUD must not obstruct the driving view.

## 11. Performance requirements

The application must run smoothly in modern browsers.

Implement:

- Map chunk streaming
- Level of detail for buildings
- Instanced rendering for repeated objects
- Efficient road meshes
- Texture compression where appropriate
- Frustum culling
- Object pooling for traffic
- Reduced detail for distant objects
- Loading indicators
- Graceful handling of missing map data

Do not load the entire city into memory at once.

Target 30–60 FPS on reasonably capable desktop hardware, with scalable graphics settings.

## 12. Project structure

Organize the code into modules such as:

src/
  game/
    Game.ts
    GameConfig.ts
  map/
    MapLoader.ts
    MapProjection.ts
    RoadNetwork.ts
    RoadMeshBuilder.ts
    BuildingGenerator.ts
    MapChunkManager.ts
  vehicle/
    VehicleController.ts
    VehiclePhysics.ts
    VehicleConfig.ts
  traffic/
    TrafficManager.ts
    TrafficVehicle.ts
    TrafficAI.ts
  navigation/
    RoutePlanner.ts
    NavigationManager.ts
  camera/
    CameraController.ts
  ui/
    HUD.ts
    MiniMap.ts
    TouchControls.ts
  input/
    InputManager.ts
  utils/
    CoordinateUtils.ts

Use clear interfaces and avoid putting the entire game inside one file.

## 13. Development phases

Build the project incrementally.

### Phase 1 — Playable MVP

- Initialize PlayCanvas.
- Render a real Colombo map area.
- Generate roads from actual OSM data.
- Create a drivable vehicle.
- Implement acceleration, braking, steering, and collisions.
- Add a chase camera.
- Add keyboard controls.
- Display a speedometer.
- Make the application playable in the browser.

### Phase 2 — City environment

- Add buildings from OSM footprints.
- Add sidewalks and road markings.
- Add vegetation and street furniture.
- Add chunk-based map streaming.

### Phase 3 — Traffic and navigation

- Add AI traffic.
- Add traffic lights.
- Add left-hand traffic.
- Add route calculation.
- Add destination selection.

### Phase 4 — Visual improvements   

- Improve vehicle models.
- Add realistic lighting and shadows.
- Add weather and time-of-day systems.
- Add cockpit camera.
- Add mobile controls.

## 14. Important development rules

Before coding:

1. Inspect the existing project.
2. Check installed dependencies.
3. Identify the current framework and project structure.
4. Create a technical implementation plan.
5. Start with the smallest playable MVP.

Do not replace existing project configuration unnecessarily.

Do not generate fake map data and present it as real Colombo geography.

Do not use placeholder road geometry when actual OSM road data can be obtained.

If a map API requires an API key, create a documented environment variable and explain how to configure it.

If an external API is unavailable, implement a local-data fallback.

Use actual geographic coordinates and preserve correct road connectivity.

Write clean, typed, maintainable code.

After implementation:

- Run the development server.
- Check for TypeScript errors.
- Check for runtime errors.
- Verify that the vehicle can drive on generated roads.
- Verify that the map represents the real Colombo area.
- Fix issues before reporting completion.

## Final objective

Deliver a working browser-based Colombo driving simulator where the player can drive a vehicle through real Colombo roads using actual geographic data.

Prioritize real geography, playable driving physics, and a working MVP before adding advanced graphics or large amounts of traffic.

Do not stop after creating a project skeleton or static 3D scene. Implement and verify the actual driving experience.