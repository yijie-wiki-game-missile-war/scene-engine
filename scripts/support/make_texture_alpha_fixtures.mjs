// Deterministic source pixels for the generic GPU color/alpha fixture.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
const directory = new URL('./texture-alpha/', import.meta.url);
mkdirSync(directory, {recursive:true});
function crc32(data) { let c=0xffffffff; for(const v of data){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}return (c^0xffffffff)>>>0 }
function chunk(type,data){const t=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([length,t,data,crc])}
for(const mode of ['straight','premultiplied','data','palette','atlas']){
 const width=64,height=64,scan=Buffer.alloc(height*(1+width*4));
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const a=[0,64,128,255][Math.floor(x/16)], rgb=mode==='premultiplied'?a:255;
  const pixel=mode==='data'?[128,128,128,255]:mode==='palette'?[64,128,192,255]:mode==='atlas'?(x<32?[255,0,0,255]:[0,255,0,255]):[rgb,rgb,rgb,a];
  scan.set(pixel,y*(1+width*4)+1+x*4);
 }
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
 writeFileSync(new URL(mode+'.png',directory),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]));
}
