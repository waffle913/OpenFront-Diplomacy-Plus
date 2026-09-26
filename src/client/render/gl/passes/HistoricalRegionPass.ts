import { createProgram } from "../utils/GlUtils";

const vertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
uniform mat3 uCamera;
uniform float uPointSize;
void main() {
  vec3 p = uCamera * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  gl_PointSize = uPointSize;
}`;

const fragmentSource = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  outColor = uColor;
}`;

export interface HistoricalRegionBoundaryStyle {
  pointSize: number;
  color: readonly [number, number, number, number];
}

export function historicalRegionBoundaryStyle(
  zoom: number,
): HistoricalRegionBoundaryStyle {
  const detail = Math.max(0, Math.min(1, (zoom - 0.9) / 3.1));
  return {
    pointSize: 1.15 + detail * 3.1,
    color: [
      0.04 + detail * 0.58,
      0.04 + detail * 0.45,
      0.04 + detail * 0.2,
      0.36 + detail * 0.5,
    ],
  };
}

export class HistoricalRegionPass {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly cameraLocation: WebGLUniformLocation;
  private readonly pointSizeLocation: WebGLUniformLocation;
  private readonly colorLocation: WebGLUniformLocation;
  private count = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly mapW: number,
    _mapH: number,
  ) {
    this.program = createProgram(gl, vertexSource, fragmentSource);
    this.vao = gl.createVertexArray()!;
    this.buffer = gl.createBuffer()!;
    this.cameraLocation = gl.getUniformLocation(this.program, "uCamera")!;
    this.pointSizeLocation = gl.getUniformLocation(this.program, "uPointSize")!;
    this.colorLocation = gl.getUniformLocation(this.program, "uColor")!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  setBoundaryTiles(tiles: Uint32Array) {
    const points = new Float32Array(tiles.length * 2);
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      points[i * 2] = (tile % this.mapW) + 0.5;
      points[i * 2 + 1] = Math.floor(tile / this.mapW) + 0.5;
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, points, this.gl.STATIC_DRAW);
    this.count = tiles.length;
  }

  draw(camera: Float32Array, zoom: number) {
    if (this.count === 0) return;
    const gl = this.gl;
    const style = historicalRegionBoundaryStyle(zoom);
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.cameraLocation, false, camera);
    gl.uniform1f(this.pointSizeLocation, style.pointSize);
    gl.uniform4fv(this.colorLocation, style.color);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.POINTS, 0, this.count);
  }

  dispose() {
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }
}
