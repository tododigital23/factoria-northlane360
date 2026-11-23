export type Point=[number,number,number];
export type ActorPose={position:Point;yaw:number;action:'rest'|'typing'|'walking'|'talking';stride:number};
export const OFFICE_SLOTS_PER_ROOM=6;
export function officeCameraFit(aspect:number){return Math.max(1,.95/Math.max(.25,aspect));}
export const OFFICE_AGENT_SCALE=.65;
export const OFFICE_MEETING_CAPACITY=6;
export const OFFICE_PREVIEW_GROUPS=3;
/** Six distinct positions outside the physical meeting table. */
export function officeMeeting(index:number):Point{
 const slot=((index%OFFICE_MEETING_CAPACITY)+OFFICE_MEETING_CAPACITY)%OFFICE_MEETING_CAPACITY;
 return [4.05+(slot%3)*1.15,0,slot<3?-4.9:-7.1];
}
export function officeMeetingPath(index:number,home:Point):Point[]{
 const side=home[0]<0?-1:1,aisle=home[2]+.32,meet=officeMeeting(index);
 // Enter through the door, then walk around the table to reach the rear row.
 const path:Point[]=[home,[home[0],0,aisle],[side*2.25,0,aisle],[side*.55,0,aisle],[side*.55,0,-6],[2.9,0,-6],[2.9,0,-4.9]];
 if(meet[2]<-6)path.push([7.45,0,-4.9],[7.45,0,-7.1]);
 return [...path,meet];
}
export function officeRoom(departmentIndex:number):Point{return [departmentIndex%2===0?-5.2:5.2,0,-2+Math.floor(departmentIndex/2)*4];}
export function officeDesk(departmentIndex:number,seat:number):Point{const c=officeRoom(departmentIndex);return [c[0]+(seat%3-1)*1.75,0,c[2]+(seat<3?-.9:.85)];}
export function officeHome(departmentIndex:number,seat:number,_seatCount=1):Point{const d=officeDesk(departmentIndex,seat);return [d[0],0,d[2]+.86*OFFICE_AGENT_SCALE];}
function along(points:Point[],progress:number):{position:Point;yaw:number}{
 const lengths=points.slice(1).map((p,i)=>Math.hypot(p[0]-points[i][0],p[2]-points[i][2])),total=lengths.reduce((a,b)=>a+b,0);let distance=Math.max(0,Math.min(1,progress))*total;
 for(let i=0;i<lengths.length;i++){if(distance<=lengths[i]||i===lengths.length-1){const a=points[i],b=points[i+1],t=lengths[i]?distance/lengths[i]:0;return {position:[a[0]+(b[0]-a[0])*t,0,a[2]+(b[2]-a[2])*t],yaw:Math.atan2(-(b[0]-a[0]),-(b[2]-a[2]))};}distance-=lengths[i];}
 return {position:points[0],yaw:Math.PI};
}
/** Visual choreography only. It never changes a worker/task or claims real communication. */
export function actorPose(index:number,time:number,home:Point,preview:boolean,working:boolean):ActorPose{
 if(!preview)return {position:home,yaw:0,action:working?'typing':'rest',stride:time};
 const cycle=((time%(50*OFFICE_PREVIEW_GROUPS))+50*OFFICE_PREVIEW_GROUPS)%(50*OFFICE_PREVIEW_GROUPS);
 const activeGroup=Math.floor(cycle/50),group=Math.floor(index/OFFICE_MEETING_CAPACITY);
 const t=cycle%50,meet=officeMeeting(index),path=officeMeetingPath(index,home);
 if(group!==activeGroup)return {position:home,yaw:0,action:'typing',stride:time};
 if(t<12||t>=41)return {position:home,yaw:0,action:'typing',stride:time};
 if(t<22)return {...along(path,(t-12)/10),action:'walking',stride:time};
 if(t<31)return {position:meet,yaw:meet[2]<-6?Math.PI:0,action:'talking',stride:time};
 return {...along([...path].reverse(),(t-31)/10),action:'walking',stride:time};
}
