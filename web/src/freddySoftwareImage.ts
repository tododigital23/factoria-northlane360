import {FREDDY_ATLAS} from './freddyProjection';

const NS='http://www.w3.org/2000/svg';
let sequence=0;
/** Runtime composition only: the original asset is never rewritten. */
export function createFreddySoftwareImage(source:string,onSelect:()=>void){
 const outer=document.createElementNS(NS,'svg'),defs=document.createElementNS(NS,'defs'),filter=document.createElementNS(NS,'filter');
 const matrix=document.createElementNS(NS,'feColorMatrix'),transfer=document.createElementNS(NS,'feComponentTransfer'),alpha=document.createElementNS(NS,'feFuncA'),image=document.createElementNS(NS,'image');
 const id=`freddy-key-${++sequence}`;
 outer.setAttribute('viewBox',`0 0 ${FREDDY_ATLAS.cellWidth} ${FREDDY_ATLAS.cropHeight}`);
 outer.setAttribute('preserveAspectRatio','none');outer.setAttribute('width','0');outer.setAttribute('height','0');outer.style.overflow='hidden';
 filter.id=id;filter.setAttribute('color-interpolation-filters','sRGB');
 // Preserve RGB and derive opacity from brightness, removing only the dark backdrop.
 matrix.setAttribute('type','matrix');matrix.setAttribute('values','1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  .333333 .333333 .333333 0 0');
 alpha.setAttribute('type','linear');alpha.setAttribute('slope',String(1/.055));alpha.setAttribute('intercept',String(-.015/.055));
 transfer.append(alpha);filter.append(matrix,transfer);defs.append(filter);
 image.setAttribute('href',source);image.setAttribute('width',String(FREDDY_ATLAS.width));image.setAttribute('height',String(FREDDY_ATLAS.height));image.setAttribute('filter',`url(#${id})`);
 outer.append(defs,image);outer.style.cursor='pointer';
 outer.addEventListener('pointerdown',event=>{event.stopPropagation();onSelect();});
 outer.addEventListener('click',event=>event.stopPropagation());
 return {outer,image};
}
