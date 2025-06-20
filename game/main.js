import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let stuart = undefined;
let stuartAnimations = undefined;

const scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer();
const loader = new GLTFLoader();
const clock = new THREE.Clock();
let mixer = undefined;
let action = undefined;

loader.load( './models/knight/knight_backwards.glb', (gltf) => {
    stuart = gltf.scene;
    stuart.scale.set(0.1,0.1,0.1);
    scene.add( stuart );

    stuartAnimations = gltf.animations;

    // console.log(gltf.animations)

    // mixer = new THREE.AnimationMixer( stuart );

    // const action = mixer.clipAction( stuartAnimations[0] ); // play the first animation
    // action.play();

     // Create an animation mixer
     mixer = new THREE.AnimationMixer(stuart);
            
     // Create an array to store all animation actions
     const animations = gltf.animations;
     
     // Get the first animation and play it
     // You can change the index to play different animations
     action = mixer.clipAction(animations[0]);
     
     // Optional animation settings
     action.setLoop(THREE.LoopRepeat); // THREE.LoopOnce, THREE.LoopRepeat, THREE.LoopPingPong
     action.clampWhenFinished = true; // Keep the final pose when animation finishes
     action.timeScale = 1; // Speed up or slow down the animation
     
     // Play the animation
     //action.play();     
     
     // Log available animations for debugging
     console.log('Available animations:', gltf.animations.map(anim => anim.name));
    
  
  }, undefined, function ( error ) {
  
    console.error( error );
  
  } );

//cube camera
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
window.camera = camera;
camera.position.z = 5;


renderer.setSize( window.innerWidth, window.innerHeight );

const canvas = renderer.domElement;
document.body.appendChild( canvas );

const controls = new OrbitControls(camera, canvas);

const cubeGeometry = new THREE.BoxGeometry( 1, 1, 1 );
//const cubeMaterial = new THREE.MeshBasicMaterial( { color: 0x00ff00, wireframe: true } );
const cubeMaterial = new THREE.MeshStandardMaterial( { color: 0x00ff00 } );
const cube = new THREE.Mesh( cubeGeometry, cubeMaterial );


const planeGeometry = new THREE.PlaneGeometry( 40, 40 );
const planeMaterial = new THREE.MeshBasicMaterial( { color: 0x444444, wireframe: false } );

const plane = new THREE.Mesh( planeGeometry, planeMaterial );

const pointLight = new THREE.PointLight( 0xFFFFFF, 1000, 1000, 2 );
pointLight.position.set( 0, 5, 5 );

const pointLightHelper = new THREE.PointLightHelper( pointLight, 1 );

const pointLight2 = new THREE.PointLight( 0xFFFFFF, 1000, 1000, 2 );
pointLight2.position.set( 0, -20, 5 );

const ambientLight = new THREE.AmbientLight( 0xffffff, 1 );

const gridHelper = new THREE.GridHelper( 200, 50 );

scene.add( gridHelper );

scene.add( pointLight );
scene.add( pointLightHelper );
scene.add( ambientLight );
scene.add( cube );

function animate() {
    const delta = clock.getDelta();
    if(mixer) {
        //console.log(mixer);
        mixer.update( delta );
    }

    if(!window.upPressed) {
        if(action){
            action.stop();
        }
    }

    if(window.upPressed) {
        debounce(function(){
            addMessage('moving up');
        }, 100);
        cube.position.z -= 0.01;
        stuart.position.z -= 0.01;
        action.play();        
    }
    if(window.downPressed) {
        cube.position.z += 0.01;
        stuart.position.z += 0.01;
    }
    if(window.leftPressed) {
        cube.position.x -= 0.01;
        stuart.position.x -= 0.01;
    }
    if(window.rightPressed) {
        cube.position.x += 0.01;
        stuart.position.x += 0.01;
    }    

    controls.update();
    window.camPositionX = camera.position.x;
    window.camPositionY = camera.position.y;
    window.camPositionZ = camera.position.z;
    cube.rotation.x += 0.005;
    cube.rotation.y += 0.005;
	renderer.render( scene, camera );
}

renderer.setAnimationLoop( animate );


function debounce(callback, delay) {
    let timer
    return function() {
      clearTimeout(timer)
      timer = setTimeout(() => {
        callback();
      }, delay)
    }
  }