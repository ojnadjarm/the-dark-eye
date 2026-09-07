#version 300 es
// One expanding ripple, shaded over its bounding box: the gradient-normalised
// distance to the ellipse `length((p-C)/(a,b)) = 1`, a 1.5 px stroke with a
// 1 px feather. Same radii, colour and alpha as `overlay.rs` strokes.
precision highp float;
in vec2 vP;
out vec4 frag;
uniform vec2 uC;
uniform vec2 uAB;
uniform vec4 uColor;
void main(){
  vec2 q = (vP - uC) / uAB;
  float f = length(q) - 1.0;
  float d = f / length(q / uAB);
  float cov = 1.0 - smoothstep(0.75 - 0.5, 0.75 + 0.5, abs(d));
  float a = cov * uColor.a;
  frag = vec4(uColor.rgb * a, a);
}
