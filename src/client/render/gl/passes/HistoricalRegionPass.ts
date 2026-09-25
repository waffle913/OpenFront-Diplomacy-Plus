import { createProgram } from "../utils/GlUtils";

const vert=`#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
uniform mat3 uCamera;
void main(){
  vec3 p=uCamera*vec3(aPos,1.0);
  gl_Position=vec4(p.xy,0.0,1.0);
  gl_PointSize=1.35;
}`;

const frag=`#version 300 es
precision highp float;
out vec4 outColor;
void main(){
  // A thin dark administrative layer: subdued at world scale, readable when zoomed in.
  outColor=vec4(0.02,0.02,0.02,0.48);
}`;

export class HistoricalRegionPass{
 private program:WebGLProgram;
 private vao:WebGLVertexArrayObject;
 private buffer:WebGLBuffer;
 private count=0;

 constructor(private gl:WebGL2RenderingContext,private mapW:number,private mapH:number){
  this.program=createProgram(gl,vert,frag);
  this.vao=gl.createVertexArray()!;
  this.buffer=gl.createBuffer()!;
  gl.bindVertexArray(this.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
 }

 setBoundaryTiles(tiles:Uint32Array){
  const pts=new Float32Array(tiles.length*2);
  for(let i=0;i<tiles.length;i++){
   const t=tiles[i];
   pts[i*2]=(t%this.mapW)+.5;
   pts[i*2+1]=Math.floor(t/this.mapW)+.5;
  }
  this.gl.bindBuffer(this.gl.ARRAY_BUFFER,this.buffer);
  this.gl.bufferData(this.gl.ARRAY_BUFFER,pts,this.gl.STATIC_DRAW);
  this.count=tiles.length;
 }

 draw(cam:Float32Array){
  if(!this.count)return;
  const gl=this.gl;
  gl.useProgram(this.program);
  gl.uniformMatrix3fv(gl.getUniformLocation(this.program,"uCamera"),false,cam);
  gl.bindVertexArray(this.vao);

  // Alpha blend the administrative/historical layer over political territory.
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.POINTS,0,this.count);
 }

 dispose(){
  this.gl.deleteBuffer(this.buffer);
  this.gl.deleteProgram(this.program);
  this.gl.deleteVertexArray(this.vao);
 }
}
