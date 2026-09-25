#version 300 es
precision highp float;
precision highp usampler2D;
in vec2 vWorldPos;
uniform usampler2D uRegionTex;
uniform vec2 uMapSize;
out vec4 outColor;
uint rid(ivec2 p){
  p=clamp(p,ivec2(0),ivec2(uMapSize)-ivec2(1));
  return texelFetch(uRegionTex,p,0).r;
}
void main(){
  ivec2 p=ivec2(floor(vWorldPos));
  uint c=rid(p);
  if(c==0u){discard;}
  bool edge=rid(p+ivec2(1,0))!=c || rid(p+ivec2(-1,0))!=c ||
            rid(p+ivec2(0,1))!=c || rid(p+ivec2(0,-1))!=c;
  if(!edge) discard;
  // one fragment-wide persistent historical boundary
  outColor=vec4(1.0,0.88,0.30,0.72);
}