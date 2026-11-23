import {Camera,Vector3} from 'three';

export const FREDDY_ATLAS={width:1536,height:1024,cellWidth:384,cropHeight:440,rowTop:492};
export const FREDDY_PLANE={width:3.05,height:3.5};

export function freddyFrame(angle:number){
 const frame=((Math.round(angle/(Math.PI/4))%8)+8)%8;
 return {x:(frame%4)*FREDDY_ATLAS.cellWidth,y:Math.floor(frame/4)*FREDDY_ATLAS.rowTop};
}

/** Project the same upright world-space plane used by WebGL into SVG pixels. */
export function freddySoftwareSize(camera:Camera,center:Vector3,viewport:{width:number;height:number}){
 camera.updateMatrixWorld();
 const depth=-center.clone().applyMatrix4(camera.matrixWorldInverse).z;
 if(depth<=0)return {width:0,height:0};
 const position=camera.getWorldPosition(new Vector3());
 const angle=Math.atan2(position.x-center.x,position.z-center.z);
 const right=new Vector3(Math.cos(angle),0,-Math.sin(angle)).multiplyScalar(FREDDY_PLANE.width/2);
 const left=center.clone().sub(right).project(camera),r=center.clone().add(right).project(camera);
 const top=center.clone().add(new Vector3(0,FREDDY_PLANE.height/2,0)).project(camera);
 const bottom=center.clone().sub(new Vector3(0,FREDDY_PLANE.height/2,0)).project(camera);
 return {width:Math.abs(r.x-left.x)*viewport.width/2,height:Math.abs(top.y-bottom.y)*viewport.height/2};
}
