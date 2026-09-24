/* =========================================================================
   AVIR GT-S — the procedural car model itself.
   Shared by the studio viewer (index.html) and the driving sim (drive.html),
   so the two can never drift apart. Needs THREE on the page first.
   ========================================================================= */
window.AVIR=(function(){
'use strict';
var T=THREE, PI=Math.PI, clamp=T.MathUtils.clamp, lerp=T.MathUtils.lerp;
/* proper sRGB workflow (r147 ships with legacy colour handling on) */
if(T.ColorManagement){
  if('legacyMode' in T.ColorManagement)T.ColorManagement.legacyMode=false;
  else T.ColorManagement.enabled=true;
}
function smoothstep(a,b,x){x=clamp((x-a)/(b-a),0,1);return x*x*(3-2*x);}
function smax(a,b,k){var h=Math.max(0,k-Math.abs(a-b))/k;return Math.max(a,b)+h*h*k*0.25;}

/* ---------- monotone cubic interpolation (no overshoot) ---------- */
function curve1D(pts){
  var n=pts.length,xs=[],ys=[],i;
  for(i=0;i<n;i++){xs.push(pts[i][0]);ys.push(pts[i][1]);}
  var dx=[],m=[];
  for(i=0;i<n-1;i++){dx[i]=xs[i+1]-xs[i];m[i]=(ys[i+1]-ys[i])/dx[i];}
  var c=new Array(n);c[0]=m[0];c[n-1]=m[n-2];
  for(i=1;i<n-1;i++){
    if(m[i-1]*m[i]<=0)c[i]=0;
    else{var w1=2*dx[i]+dx[i-1],w2=dx[i]+2*dx[i-1];c[i]=(w1+w2)/(w1/m[i-1]+w2/m[i]);}
  }
  return function(x){
    if(x<=xs[0])return ys[0];
    if(x>=xs[n-1])return ys[n-1];
    var i=0;while(i<n-2&&x>xs[i+1])i++;
    var h=dx[i],t=(x-xs[i])/h,t2=t*t,t3=t2*t;
    return ys[i]*(2*t3-3*t2+1)+h*c[i]*(t3-2*t2+t)+ys[i+1]*(-2*t3+3*t2)+h*c[i+1]*(t3-t2);
  };
}

/* ---------- parametric surface builder ---------- */
/* How finely the big lofted surfaces are tessellated. 1 is what the studio
   wants, where the car fills the screen and you can lean into a panel gap.
   The driving sim never sees it closer than a few metres, and at 0.6 the
   silhouette is identical for a third of the triangles. */
var LOD=1;
function sg(n){return Math.max(6,Math.round(n*LOD));}
function buildSurface(fn,uSeg,vSeg,opt){
  opt=opt||{};
  var closed=!!opt.closedV, vCount=closed?vSeg:vSeg+1;
  var pos=new Float32Array((uSeg+1)*vCount*3), uvs=new Float32Array((uSeg+1)*vCount*2);
  var idx=[],k=0,k2=0,i,j;
  for(i=0;i<=uSeg;i++){
    var u=i/uSeg;
    for(j=0;j<vCount;j++){
      var v=j/vSeg,p=fn(u,v);
      pos[k++]=p.x;pos[k++]=p.y;pos[k++]=p.z;
      uvs[k2++]=v;uvs[k2++]=1-u;
    }
  }
  for(i=0;i<uSeg;i++)for(j=0;j<vSeg;j++){
    /* opt.skip punches holes: a quad whose centre it claims is never emitted */
    if(opt.skip&&opt.skip((i+0.5)/uSeg,(j+0.5)/vSeg))continue;
    var j1=(j+1)%vCount,a=i*vCount+j,b=i*vCount+j1,c2=(i+1)*vCount+j1,d=(i+1)*vCount+j;
    if(opt.flip)idx.push(a,b,d,b,c2,d); else idx.push(a,d,b,b,d,c2);
  }
  var g=new T.BufferGeometry();
  g.setAttribute('position',new T.BufferAttribute(pos,3));
  g.setAttribute('uv',new T.BufferAttribute(uvs,2));
  g.setIndex(idx);g.computeVertexNormals();
  return g;
}
/* offset a surface along its own normal */
function offsetFn(fn,d){
  var e=0.0015;
  return function(u,v){
    var p=fn(u,v);
    var pu=fn(Math.min(1,u+e),v).sub(fn(Math.max(0,u-e),v));
    var pv=fn(u,Math.min(1,v+e)).sub(fn(u,Math.max(0,v-e)));
    var n=pu.cross(pv);
    if(n.lengthSq()<1e-12)return p;
    return p.addScaledVector(n.normalize(),d);
  };
}
/* offset by a per-point distance (used for sunken panels: recesses, grilles, vents) */
function offsetVarFn(fn,dFn){
  var e=0.0015;
  return function(u,v){
    var p=fn(u,v);
    var pu=fn(Math.min(1,u+e),v).sub(fn(Math.max(0,u-e),v));
    var pv=fn(u,Math.min(1,v+e)).sub(fn(u,Math.max(0,v-e)));
    var n=pu.cross(pv);
    if(n.lengthSq()<1e-12)return p;
    return p.addScaledVector(n.normalize(),dFn(u,v));
  };
}
/* raised panel whose border melts back into the surface */
function fadeOffsetFn(fn,off,soft){
  soft=soft||0.07;
  return offsetVarFn(fn,function(u,v){
    var e=Math.min(smoothstep(0,soft,u),smoothstep(0,soft,1-u),
                   smoothstep(0,soft,v),smoothstep(0,soft,1-v));
    return off*e;
  });
}
/* a panel whose rim stays flush with the skin and whose centre sinks in */
function dishFn(fn,depth,soft){
  soft=soft||0.16;
  return offsetVarFn(fn,function(u,v){
    var e=Math.min(smoothstep(0,soft,u),smoothstep(0,soft,1-u),
                   smoothstep(0,soft,v),smoothstep(0,soft,1-v));
    return depth*e;
  });
}
/* sub-rectangle of a surface, optionally offset */
function patch(fn,u0,u1,v0,v1,off){
  var f=function(u,v){return fn(lerp(u0,u1,u),lerp(v0,v1,v));};
  return off?offsetFn(f,off):f;
}
/* sub-rectangle whose v-range follows a per-station anchor */
function patchV(fn,u0,u1,f0,f1,off){
  var f=function(u,v){
    var U=lerp(u0,u1,u);
    return fn(U,lerp(f0(U),f1(U),v));
  };
  return off?offsetFn(f,off):f;
}
/* frame (position + normal) at a surface point */
function frameAt(fn,u,v){
  var e=0.0015,p=fn(u,v);
  var pu=fn(Math.min(1,u+e),v).sub(fn(Math.max(0,u-e),v)).normalize();
  var pv=fn(u,Math.min(1,v+e)).sub(fn(u,Math.max(0,v-e))).normalize();
  var n=pu.clone().cross(pv).normalize();
  return {p:p,n:n,u:pu,v:pv};
}
/* orient an object so +Z points along the surface normal */
function orientTo(obj,p,n,up){
  obj.position.copy(p);
  var m=new T.Matrix4(),z=n.clone().normalize();
  var x=new T.Vector3().crossVectors(up||new T.Vector3(0,1,0),z);
  if(x.lengthSq()<1e-6)x.set(1,0,0);
  x.normalize();
  var y=new T.Vector3().crossVectors(z,x);
  m.makeBasis(x,y,z);obj.quaternion.setFromRotationMatrix(m);
  return obj;
}

/* ---------- rounded box (sphere-warp technique) ---------- */
function roundedBox(w,h,d,r,seg){
  seg=seg||14;r=Math.min(r,w/2,h/2,d/2);
  var g=new T.SphereGeometry(1,seg*2,seg),p=g.attributes.position;
  var hw=Math.max(0,w/2-r),hh=Math.max(0,h/2-r),hd=Math.max(0,d/2-r);
  for(var i=0;i<p.count;i++){
    var x=p.getX(i),y=p.getY(i),z=p.getZ(i);
    p.setXYZ(i,Math.sign(x)*hw+x*r,Math.sign(y)*hh+y*r,Math.sign(z)*hd+z*r);
  }
  p.needsUpdate=true;g.computeVertexNormals();
  return g;
}
/* ---------- surface of revolution around the X axis ---------- */
/* prof: [[x, radius], ...] */
function revolveX(prof,seg,closedProfile){
  var n=prof.length;
  return buildSurface(function(u,v){
    var f=u*(n-1),i=Math.min(n-2,Math.floor(f)),t=f-i;
    var x=lerp(prof[i][0],prof[i+1][0],t),r=lerp(prof[i][1],prof[i+1][1],t);
    var a=v*PI*2;
    return new T.Vector3(x,r*Math.cos(a),r*Math.sin(a));
  },n*3,seg,{closedV:true,flip:true});
}
window.__CARUTIL={curve1D:curve1D,buildSurface:buildSurface,offsetFn:offsetFn,patch:patch,
  frameAt:frameAt,orientTo:orientTo,roundedBox:roundedBox,revolveX:revolveX,smax:smax,smoothstep:smoothstep};

/* ================= CANVAS TEXTURES ================= */
function cvs(w,h){var c=document.createElement('canvas');c.width=w;c.height=h;return c;}
function tex(c,rx,ry,srgb){
  var t=new T.CanvasTexture(c);
  t.wrapS=t.wrapT=T.RepeatWrapping;t.repeat.set(rx||1,ry||1);
  t.anisotropy=8;if(srgb!==false)t.encoding=T.sRGBEncoding;
  return t;
}
/* honeycomb mesh (used for grille + intakes) */
function hexTexture(){
  var c=cvs(256,222),x=c.getContext('2d');
  x.fillStyle='#05070a';x.fillRect(0,0,256,222);
  var r=26,h=Math.sqrt(3)/2*r;
  x.strokeStyle='#39404d';x.lineWidth=5;
  for(var row=-1;row<6;row++)for(var col=-1;col<7;col++){
    var cx=col*r*1.5+(row%2?r*0.75:0),cy=row*h*2+(row%2?h:0);
    x.beginPath();
    for(var i=0;i<6;i++){var a=PI/180*(60*i);var px=cx+r*0.92*Math.cos(a),py=cy+r*0.92*Math.sin(a);
      i?x.lineTo(px,py):x.moveTo(px,py);}
    x.closePath();x.stroke();
  }
  return c;
}
/* tyre: tread blocks + sidewall lettering. u = circumference, v = profile */
function tyreTexture(){
  var W=1024,H=512,c=cvs(W,H),x=c.getContext('2d');
  x.fillStyle='#131417';x.fillRect(0,0,W,H);
  // sidewalls (v<0.30 and v>0.70)
  var g=x.createLinearGradient(0,0,0,H);
  g.addColorStop(0,'#1b1d21');g.addColorStop(.3,'#101114');g.addColorStop(.5,'#0c0d10');
  g.addColorStop(.7,'#101114');g.addColorStop(1,'#1b1d21');
  x.fillStyle=g;x.fillRect(0,0,W,H);
  // tread band
  x.fillStyle='#0a0b0d';x.fillRect(0,H*0.30,W,H*0.40);
  // circumferential grooves
  x.fillStyle='#050506';
  [0.345,0.47,0.59,0.655].forEach(function(p){x.fillRect(0,H*p,W,10);});
  // lateral tread blocks
  x.strokeStyle='#050506';x.lineWidth=9;
  for(var i=0;i<46;i++){
    var px=i/46*W;
    x.beginPath();x.moveTo(px,H*0.30);x.lineTo(px+26,H*0.47);x.lineTo(px+4,H*0.70);x.stroke();
  }
  // sidewall lettering
  x.save();
  for(var s=0;s<2;s++){
    var y=s?H*0.845:H*0.155;
    x.fillStyle='#2a2d33';x.font='bold 30px Arial';x.textAlign='center';x.textBaseline='middle';
    for(var k=0;k<4;k++){
      x.fillText('AVIR  SPORT  GT',W*(k+0.25)/4,y);
      x.font='bold 19px Arial';x.fillStyle='#22252b';
      x.fillText('245/35 ZR19',W*(k+0.75)/4,y);
      x.font='bold 30px Arial';x.fillStyle='#2a2d33';
    }
  }
  x.restore();
  return c;
}
/* carbon fibre weave */
function carbonTexture(){
  var c=cvs(128,128),x=c.getContext('2d');
  x.fillStyle='#0d0e11';x.fillRect(0,0,128,128);
  for(var i=0;i<4;i++)for(var j=0;j<4;j++){
    var s=32,px=i*s,py=j*s,dark=(i+j)%2===0;
    var g=x.createLinearGradient(px,py,px+s,py+s);
    g.addColorStop(0,dark?'#22252b':'#15171b');g.addColorStop(.5,dark?'#31353d':'#1d2025');
    g.addColorStop(1,dark?'#191c21':'#0f1115');
    x.fillStyle=g;x.fillRect(px,py,s,s);
  }
  return c;
}
/* israeli style number plate */
function plateTexture(num){
  var c=cvs(512,140),x=c.getContext('2d');
  x.fillStyle='#f5c518';x.fillRect(0,0,512,140);
  x.fillStyle='#1a1c20';x.fillRect(0,0,512,7);x.fillRect(0,133,512,7);
  x.fillRect(0,0,7,140);x.fillRect(505,0,7,140);
  x.fillStyle='#1b3fae';x.fillRect(7,7,52,126);
  x.fillStyle='#fff';x.font='bold 26px Arial';x.textAlign='center';
  x.fillText('IL',33,60);
  x.beginPath();x.arc(33,96,13,0,PI*2);x.fillStyle='#fff';x.fill();
  x.fillStyle='#1a1c20';x.font='bold 74px Arial';x.textAlign='center';x.textBaseline='middle';
  x.fillText(num,292,76);
  return c;
}
/* marque emblem */
function logoTexture(){
  var c=cvs(256,256),x=c.getContext('2d');
  x.clearRect(0,0,256,256);
  var g=x.createLinearGradient(0,0,256,256);
  g.addColorStop(0,'#e9edf5');g.addColorStop(.45,'#9aa4b8');g.addColorStop(.55,'#f4f7ff');g.addColorStop(1,'#5c6474');
  x.fillStyle=g;x.beginPath();x.arc(128,128,124,0,PI*2);x.fill();
  x.fillStyle='#0b0d12';x.beginPath();x.arc(128,128,108,0,PI*2);x.fill();
  // stylised wing / "A"
  x.fillStyle=g;
  x.beginPath();x.moveTo(128,44);x.lineTo(196,196);x.lineTo(160,196);x.lineTo(128,120);
  x.lineTo(96,196);x.lineTo(60,196);x.closePath();x.fill();
  x.fillStyle='#0b0d12';x.fillRect(104,150,48,14);
  x.strokeStyle=g;x.lineWidth=4;x.beginPath();x.arc(128,128,116,0,PI*2);x.stroke();
  return c;
}
/* instrument cluster */
function gaugeTexture(){
  var c=cvs(512,256),x=c.getContext('2d');
  x.fillStyle='#04060a';x.fillRect(0,0,512,256);
  function dial(cx,cy,r,label,val){
    x.strokeStyle='#1a2230';x.lineWidth=8;
    x.beginPath();x.arc(cx,cy,r,PI*0.75,PI*2.25);x.stroke();
    x.strokeStyle='#00d4ff';x.lineWidth=8;
    x.beginPath();x.arc(cx,cy,r,PI*0.75,PI*0.75+PI*1.5*val);x.stroke();
    for(var i=0;i<=8;i++){
      var a=PI*0.75+PI*1.5*(i/8);
      x.strokeStyle='#48566b';x.lineWidth=3;
      x.beginPath();x.moveTo(cx+Math.cos(a)*(r-13),cy+Math.sin(a)*(r-13));
      x.lineTo(cx+Math.cos(a)*(r-3),cy+Math.sin(a)*(r-3));x.stroke();
    }
    x.fillStyle='#7f8ca0';x.font='bold 15px Arial';x.textAlign='center';x.fillText(label,cx,cy+r-6);
  }
  dial(112,132,86,'RPM',0.42);dial(400,132,86,'KM/H',0.35);
  x.fillStyle='#eef3ff';x.font='bold 62px Arial';x.textAlign='center';x.textBaseline='middle';
  x.fillText('118',256,120);
  x.fillStyle='#5d6a80';x.font='bold 17px Arial';x.fillText('AVIR  GT-S',256,178);
  x.fillStyle='#ff2d6f';x.font='bold 20px Arial';x.fillText('3',112,124);
  return c;
}
/* soft radial blob – used for contact shadow + light glow */
function blobTexture(inner,fade){
  var c=cvs(256,256),x=c.getContext('2d');
  var g=x.createRadialGradient(128,128,0,128,128,128);
  g.addColorStop(0,'rgba(0,0,0,'+inner+')');
  g.addColorStop(fade||0.45,'rgba(0,0,0,'+(inner*0.45)+')');
  g.addColorStop(1,'rgba(0,0,0,0)');
  x.fillStyle=g;x.fillRect(0,0,256,256);
  return c;
}

/* ================= MATERIALS ================= */
var MAT={};
function makeMaterials(env){
  var hexT=tex(hexTexture(),9,4);
  /* the shell is an open surface once the doors are cut out of it, so it has
     to be drawn from both faces - single-sided you can see straight through
     the car from any low angle */
  MAT.paint=new T.MeshPhysicalMaterial({side:T.DoubleSide,shadowSide:T.BackSide,
    color:0x8c0f1c,metalness:0.55,roughness:0.30,
    clearcoat:1,clearcoatRoughness:0.06,envMap:env,envMapIntensity:0.95});
  MAT.paintDark=new T.MeshPhysicalMaterial({color:0x14161b,metalness:0.55,roughness:0.34,
    clearcoat:1,clearcoatRoughness:0.10,envMap:env,envMapIntensity:1.1});
  MAT.glassBoth=null;                       /* set below, once glass exists */
  MAT.glass=new T.MeshPhysicalMaterial({color:0x05080d,metalness:0.0,roughness:0.028,
    transparent:true,opacity:0.56,envMap:env,envMapIntensity:0.62,side:T.DoubleSide,
    reflectivity:0.62,clearcoat:0.55,clearcoatRoughness:0.02,depthWrite:false});
  MAT.chrome=new T.MeshPhysicalMaterial({color:0xd6dde9,metalness:1,roughness:0.10,envMap:env,envMapIntensity:0.92});
  MAT.satin=new T.MeshPhysicalMaterial({color:0x7d8593,metalness:1,roughness:0.36,envMap:env,envMapIntensity:0.90});
  MAT.gloss=new T.MeshPhysicalMaterial({color:0x0a0b0e,metalness:0.30,roughness:0.24,
    clearcoat:0.6,clearcoatRoughness:0.10,envMap:env,envMapIntensity:0.85});
  MAT.trim=new T.MeshStandardMaterial({color:0x101216,metalness:0.45,roughness:0.52,envMap:env,envMapIntensity:0.8});
  MAT.matte=new T.MeshStandardMaterial({color:0x0b0c0f,metalness:0.15,roughness:0.85,envMap:env,envMapIntensity:0.5});
  MAT.pillar=new T.MeshStandardMaterial({color:0x090a0c,metalness:0.0,roughness:0.90,envMap:env,envMapIntensity:0.16});
  /* the door's own glass is seen from inside too once the door swings open */
  MAT.glassBoth=MAT.glass.clone();MAT.glassBoth.side=T.DoubleSide;
  /* seen from either face: the cut edge of the door aperture and the door's own rim */
  MAT.inner=new T.MeshStandardMaterial({color:0x090a0d,metalness:0.10,roughness:0.90,side:T.DoubleSide,
    envMap:env,envMapIntensity:0.16});
  MAT.well=new T.MeshStandardMaterial({color:0x070809,metalness:0.05,roughness:0.96,envMap:env,envMapIntensity:0.10});
  MAT.gap=new T.MeshStandardMaterial({color:0x15171c,metalness:0.25,roughness:0.80,envMap:env,envMapIntensity:0.35,
    polygonOffset:true,polygonOffsetFactor:-6,polygonOffsetUnits:-6});
  MAT.crease=new T.MeshPhysicalMaterial({color:0x8c0f1c,metalness:0.55,roughness:0.30,clearcoat:1,
    clearcoatRoughness:0.06,envMap:env,envMapIntensity:0.95,
    polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:-3});
  MAT.rubber=new T.MeshStandardMaterial({color:0x0e0f12,roughness:0.93,metalness:0.02,envMap:env,envMapIntensity:0.35});
  MAT.mesh=new T.MeshStandardMaterial({map:hexT,color:0x2e333c,metalness:0.75,roughness:0.46,envMap:env,envMapIntensity:1.25});
  MAT.carbon=new T.MeshPhysicalMaterial({map:tex(carbonTexture(),11,11),color:0x1e2126,metalness:0.18,roughness:0.66,
    clearcoat:0,envMap:env,envMapIntensity:0.28});
  MAT.leather=new T.MeshStandardMaterial({color:0x181b20,roughness:0.72,metalness:0.05,envMap:env,envMapIntensity:0.45});
  MAT.alcantara=new T.MeshStandardMaterial({color:0x1d2128,roughness:0.95,metalness:0,envMap:env,envMapIntensity:0.20});
  MAT.stitch=new T.MeshStandardMaterial({color:0xc03050,roughness:0.6});
  MAT.skin=new T.MeshStandardMaterial({color:0xc98d6a,roughness:0.72,metalness:0,
    envMap:env,envMapIntensity:0.28});
  MAT.hair=new T.MeshStandardMaterial({color:0x25201d,roughness:0.78,metalness:0.05,
    envMap:env,envMapIntensity:0.3});
  MAT.shirt=new T.MeshStandardMaterial({color:0xffffff,roughness:0.86,metalness:0,
    envMap:env,envMapIntensity:0.22});
  MAT.trouser=new T.MeshStandardMaterial({color:0x2b3242,roughness:0.9,metalness:0,
    envMap:env,envMapIntensity:0.18});
  MAT.shoe=new T.MeshStandardMaterial({color:0x15171c,roughness:0.55,metalness:0.1,
    envMap:env,envMapIntensity:0.4});
  MAT.shades=new T.MeshStandardMaterial({color:0x0a0c10,roughness:0.18,metalness:0.6,
    envMap:env,envMapIntensity:1.1});
  /* the rest of the driver: eyes, lips, tee, sleeves, belt and shoe soles */
  MAT.eye=new T.MeshStandardMaterial({color:0x2a2018,roughness:0.16,metalness:0,
    envMap:env,envMapIntensity:1.0});
  MAT.lip=new T.MeshStandardMaterial({color:0x9c5b52,roughness:0.62,metalness:0,
    envMap:env,envMapIntensity:0.25});
  MAT.tee=new T.MeshStandardMaterial({color:0xd8dbe2,roughness:0.92,metalness:0,
    envMap:env,envMapIntensity:0.18});
  MAT.sleeve=new T.MeshStandardMaterial({color:0x232935,roughness:0.88,metalness:0,
    envMap:env,envMapIntensity:0.20});
  MAT.belt=new T.MeshStandardMaterial({color:0x1a1c22,roughness:0.55,metalness:0.15,
    envMap:env,envMapIntensity:0.45});
  MAT.sole=new T.MeshStandardMaterial({color:0xd9dbe0,roughness:0.72,metalness:0.02,
    envMap:env,envMapIntensity:0.25});
  MAT.discMetal=new T.MeshStandardMaterial({color:0x6e747d,metalness:1,roughness:0.36,envMap:env,envMapIntensity:1.1});
  MAT.caliper=new T.MeshPhysicalMaterial({color:0xc21c33,metalness:0.35,roughness:0.30,
    clearcoat:1,clearcoatRoughness:0.15,envMap:env,envMapIntensity:1});
  MAT.tyre=new T.MeshStandardMaterial({map:tex(tyreTexture(),1,1),bumpMap:tex(tyreTexture(),1,1,false),
    bumpScale:0.012,color:0xffffff,roughness:0.88,metalness:0.03,envMap:env,envMapIntensity:0.35});
  MAT.rim=new T.MeshPhysicalMaterial({color:0x2a2d33,metalness:1,roughness:0.24,envMap:env,envMapIntensity:1.15,
    clearcoat:0.6,clearcoatRoughness:0.15});
  MAT.lensClear=new T.MeshPhysicalMaterial({color:0xdfe9ff,metalness:0,roughness:0.04,transparent:true,
    opacity:0.26,envMap:env,envMapIntensity:1.5,side:T.DoubleSide,depthWrite:false,
    clearcoat:1,clearcoatRoughness:0.02});
  MAT.lensRed=new T.MeshPhysicalMaterial({color:0x4a0410,metalness:0,roughness:0.06,transparent:true,
    opacity:0.55,envMap:env,envMapIntensity:2.2,side:T.DoubleSide,depthWrite:false});
  MAT.reflector=new T.MeshStandardMaterial({color:0xf2f5ff,metalness:1,roughness:0.10,envMap:env,envMapIntensity:1.15});
  MAT.ledOff=new T.MeshStandardMaterial({color:0xb8c6dc,emissive:0x33455f,emissiveIntensity:0.8,roughness:0.28,metalness:0.4});
  MAT.ledOn=new T.MeshBasicMaterial({color:0xf2f7ff,toneMapped:false});
  MAT.tailOff=new T.MeshStandardMaterial({color:0x5a0714,emissive:0x8e0a1e,emissiveIntensity:0.42,roughness:0.22,metalness:0.25});
  MAT.tailOn=new T.MeshBasicMaterial({color:0xff1030,toneMapped:false});
  MAT.amber=new T.MeshStandardMaterial({color:0xff8a1e,emissive:0x3a1600,roughness:0.3});
  MAT.screen=new T.MeshBasicMaterial({map:tex(gaugeTexture(),1,1),toneMapped:false});
  MAT.plateF=new T.MeshStandardMaterial({map:tex(plateTexture('77-981-42'),1,1),roughness:0.42,metalness:0.05,envMap:env,envMapIntensity:0.6});
  MAT.plateR=MAT.plateF;
  MAT.logo=new T.MeshStandardMaterial({map:tex(logoTexture(),1,1),transparent:true,roughness:0.18,metalness:0.9,envMap:env,envMapIntensity:1.6});
  MAT.badge=new T.MeshStandardMaterial({color:0xd6dcea,metalness:1,roughness:0.2,envMap:env,envMapIntensity:1.5});
}

/* ================= CAR DIMENSIONS ================= */
var CAR={zF:2.22,zR:-2.26,axF:1.42,axR:-1.42,
  trF:0.836,trR:0.826, rF:0.362,rR:0.378, hwF:0.138,hwR:0.170,
  archF:0.372,archR:0.392};
function zAt(u){return lerp(CAR.zF,CAR.zR,u);}
function uAt(z){return (CAR.zF-z)/(CAR.zF-CAR.zR);}

/* the shoulder kicks up ~8 cm through the cabin: a higher waist and a
   shallower glasshouse, which is what buys the door a taller opening.
   The lift tapers to nothing at both ends of the greenhouse, so the
   windscreen and the rear glass keep their depth. */
var topLine=curve1D([[-2.26,0.828],[-2.10,0.874],[-1.85,0.920],[-1.60,0.958],[-1.42,0.992],
  [-1.10,1.010],[-0.55,1.008],[0,1.000],[0.40,0.972],[0.70,0.922],[1.05,0.888],[1.42,0.856],
  [1.80,0.792],[2.06,0.722],[2.22,0.668]]);
var halfW=curve1D([[-2.26,0.856],[-2.08,0.902],[-1.78,0.962],[-1.42,1.002],[-1.00,0.968],
  [-0.30,0.946],[0.35,0.946],[0.95,0.960],[1.42,0.992],[1.76,0.966],[2.04,0.930],[2.22,0.896]]);
var floorY=curve1D([[-2.26,0.296],[-2.06,0.232],[-1.78,0.168],[-1.40,0.134],[0,0.120],
  [1.40,0.134],[1.78,0.164],[2.06,0.210],[2.22,0.258]]);
var sillY=curve1D([[-2.26,0.326],[-2.00,0.264],[-1.70,0.208],[-1.25,0.188],[0,0.180],
  [1.25,0.188],[1.70,0.211],[2.00,0.258],[2.22,0.296]]);

function archOne(z,ax,r,yc){
  var t=Math.abs(z-ax)/r;
  if(t<=0.82)return yc+r*Math.sqrt(1-t*t);
  if(t>=1.18)return yc-(t-1.18)*r*2.2;
  /* Hermite run-out: matches the circle at 0.82 and the straight tail at 1.18,
     so the lip never goes vertical (that is what produced the saw-tooth edge) */
  var q=(t-0.82)/0.36,q2=q*q,q3=q2*q;
  var h00=2*q3-3*q2+1,h10=q3-2*q2+q,h01=-2*q3+3*q2,h11=q3-q2;
  return yc+r*(h00*0.5724+h10*(-0.5157)+h01*0+h11*(-0.792));
}
function archEdge(z){return Math.max(archOne(z,CAR.axF,CAR.archF,CAR.rF),archOne(z,CAR.axR,CAR.archR,CAR.rR));}
function outerBottom(z){return smax(sillY(z),archEdge(z),0.135);}
function cabin(z){return smoothstep(0.72,0.40,z)*smoothstep(-1.44,-1.10,z);}

/* ---- cross section of the body shell (closed loop, incl. interior tub) ---- */
var _secCache={},_secKeys=[];
function section(u){
  var key=u.toFixed(5),hit=_secCache[key];
  if(hit)return hit;
  var z=zAt(u),W=halfW(z),yT=topLine(z),yF=floorY(z),yS=sillY(z),yE=outerBottom(z);
  var a=smoothstep(0.00,0.36,yE-yS);              /* wheel-arch blend */
  var c=cabin(z);                                  /* interior tub blend */
  var yMax=lerp(yE+(yT-yE)*0.36,yE+0.052,a);
  var P=[
    [0,yF],
    [0.46*W,yF+0.012],
    [lerp(0.86,0.575,a)*W,lerp(yF+0.075,yE-0.295,a)],
    [lerp(0.972,0.988,a)*W,yE+0.020],
    [W,yMax],
    [0.975*W,yE+(yT-yE)*0.78],
    [0.815*W,yT-0.026],
    [0.780*W,yT],
    [lerp(0.700*W,0.755*W,c),lerp(yT-0.0015,yT-0.150,c)],
    [lerp(0.520*W,0.722*W,c),lerp(yT-0.0030,0.560,c)],
    [lerp(0.280*W,0.680*W,c),lerp(yT-0.0045,0.437,c)],
    [0,lerp(yT-0.0060,0.425,c)]
  ];
  var pts=[],i;
  for(i=0;i<P.length;i++)pts.push(new T.Vector3(P[i][0],P[i][1],0));
  for(i=P.length-2;i>=1;i--)pts.push(new T.Vector3(-P[i][0],P[i][1],0));
  var cv=new T.CatmullRomCurve3(pts,true,'catmullrom',0.5);
  var sp=cv.getPoints(255);sp.length=255;
  _secCache[key]=sp;_secKeys.push(key);
  if(_secKeys.length>600){delete _secCache[_secKeys.shift()];}
  return sp;
}
function bodySurf(u,v){
  var s=section(u),n=s.length,f=((v%1)+1)%1*n,i=Math.floor(f),t=f-i,j=(i+1)%n;
  return new T.Vector3(lerp(s[i].x,s[j].x,t),lerp(s[i].y,s[j].y,t),zAt(u));
}
/* find v on the outer right skin closest to a target point */
function vOuter(u,ty){
  var s=section(u),n=s.length,W=halfW(zAt(u)),lim=Math.floor(n*0.44),i,prev=-1;
  var best=0,bd=1e9;
  for(i=0;i<lim;i++){
    var p=s[i];
    if(p.x<0.62*W){prev=-1;continue;}
    var d=Math.abs(p.y-ty);if(d<bd){bd=d;best=i;}
    if(prev>=0){
      var y0=s[prev].y,y1=p.y;
      if((y0-ty)*(y1-ty)<=0&&y0!==y1)return (prev+(ty-y0)/(y1-y0)*(i-prev))/n;
    }
    prev=i;
  }
  return best/n;
}
function vDeck(u,tx){
  var s=section(u),n=s.length,yT=topLine(zAt(u)),i,prev=-1,best=0,bd=1e9;
  var lo=Math.floor(n*0.12),hi=Math.floor(n*0.5);
  for(i=lo;i<hi;i++){
    var p=s[i];
    if(p.y<yT-0.22){prev=-1;continue;}
    var d=Math.abs(p.x-tx);if(d<bd){bd=d;best=i;}
    if(prev>=0){
      var x0=s[prev].x,x1=p.x;
      if((x0-tx)*(x1-tx)<=0&&x0!==x1)return (prev+(tx-x0)/(x1-x0)*(i-prev))/n;
    }
    prev=i;
  }
  return best/n;
}

/* ---- door aperture ----------------------------------------------
   The shell is one lofted surface, so a door that opens has to be a
   hole in it. The outline below is the single source of truth: the
   shell skips the quads inside it, the door panel is sampled from the
   same skin just outside it, and the rebate closes the cut edge. */
var DOOR={z0:0.55,z1:-0.62,hinge:[0.60,0.470,0.585],open:1.02};
DOOR.u0=uAt(DOOR.z0);DOOR.u1=uAt(DOOR.z1);
DOOR.yLo=function(z){return sillY(z)+0.035;};      /* the panel's bottom edge */
/* ...but the hole stops at the cabin floor. Below that is the rocker, which
   is solid body: cutting into it only exposed the cavity inside. */
DOOR.yCut=function(z){return 0.440;};
/* The top of the cut is the shoulder crest itself - see vCrest. Stopping the
   cut 3 cm short of it left the crest standing: a 4 cm rail of bodywork lying
   across the whole top of the opening, which from three-quarters reads as a
   long red bar floating through the cabin over the wheel and the seats. The
   beltline edge belongs to the door, so the door carries it. */
/* and the side window is the door's, not the canopy's: greenhouse u range
   (behind the A-pillar, out to the door's rear shut line) and the fraction
   of the glass height it spans */
DOOR.wu0=0.250;DOOR.wu1=0.585;DOOR.wf0=0.0;DOOR.wf1=0.850;
/* the character line's v at station u, on the +X flank */
function creaseV(u){var z=zAt(u);return vOuter(u,lerp(0.60,0.66,smoothstep(1.3,-1.3,z)));}
/* the shoulder crest: the highest point of the +X flank, where the outer skin
   turns over into the cabin wall. It is the fold the cut has to clear - stop
   below it and the fold is left bridging the opening. */
function crestI(s,lim){var i,cr=0,cy=-1e9;for(i=0;i<lim;i++)if(s[i].y>cy){cy=s[i].y;cr=i;}return cr;}
function vCrest(u){var s=section(u),n=s.length;return crestI(s,Math.floor(n*0.46))/n;}
/* v on the cabin side of the crest at height ty. The shoulder is a hollow
   box - outer skin, crest, inner wall - so a door opening has to be cut
   through both walls, or the inner one stands across it like a panel. */
function vInner(u,ty){
  var s=section(u),n=s.length,lim=Math.floor(n*0.46),i,cr=crestI(s,lim);
  for(i=cr+1;i<lim;i++){
    var y0=s[i-1].y,y1=s[i].y;
    if((y0-ty)*(y1-ty)<=0&&y0!==y1)return (i-1+(ty-y0)/(y1-y0))/n;
  }
  return -1;    /* no crossing: at the front of the door the tub has not
                   opened yet. Returning a mid-section v instead sent the
                   frame stretching to the car's centreline - a thin sheet
                   right across the cabin. */
}
/* v of the outline at station u, on the +X flank. One-entry memo because
   both the shell mask and the panel walk u monotonically. */
var _dlU=-1,_dlLo=0,_dlCut=0,_dlHi=0,_dlCutIn=0,_dlHiIn=0;
function doorLim(u){
  if(u!==_dlU){var z=zAt(u);_dlU=u;
    _dlLo=vOuter(u,DOOR.yLo(z));_dlCut=vOuter(u,DOOR.yCut(z));
    _dlHi=_dlHiIn=vCrest(u);        /* both walls are cut right up to the fold */
    _dlCutIn=vInner(u,DOOR.yCut(z));}
  return _dlU;
}
function doorLo(u){doorLim(u);return _dlLo;}
function doorCut(u){doorLim(u);return _dlCut;}
function doorHi(u){doorLim(u);return _dlHi;}
/* where there is no inner wall to cut, both collapse onto the crest and the
   frame degenerates to nothing rather than sweeping across the interior */
function doorCutIn(u){doorLim(u);return _dlCutIn<0?_dlHi:_dlCutIn;}
function doorHiIn(u){doorLim(u);return _dlHiIn;}
function doorHasIn(u){doorLim(u);return _dlCutIn>=0;}
/* quads the shell must not emit. One run: up the outer skin, over the crest
   and back down the cabin wall, so the opening is clear from the sill to the
   roof rail with nothing left lying across its top. */
function doorSkip(u,v){
  if(u<=DOOR.u0||u>=DOOR.u1)return false;
  doorLim(u);
  var hi=_dlCutIn<0?_dlHi:_dlCutIn;
  return (v>_dlCut&&v<hi)||(v>1-hi&&v<1-_dlCut);
}

/* ---- greenhouse (glass canopy) ---- */
var GH={z0:0.700,z1:-1.560,u0:-0.048,u1:1.038};
var roofY=curve1D([[-1.56,0.945],[-1.34,1.075],[-1.02,1.230],[-0.66,1.330],[-0.28,1.368],
  [0.06,1.352],[0.32,1.262],[0.54,1.108],[0.70,0.958]]);
var ghW=curve1D([[-1.56,0.620],[-1.25,0.722],[-0.80,0.782],[-0.10,0.788],[0.32,0.758],[0.70,0.640]]);
function ghBase(z){return topLine(z)-0.064;}
/* The canopy is an open tube: its front rim ends at the cowl and its rear rim at
   the deck. Sampled past u=0 / u=1 the section is pushed down so those rims sink
   under the skin instead of showing a gap along the glass. */
function ghDip(u){
  var d=0;
  if(u<0)d+=0.150*smoothstep(0,-0.048,u);
  if(u>1)d+=0.105*smoothstep(1,1.038,u);
  return d;
}
function ghZ(u){return lerp(GH.z0,GH.z1,u);}
var _ghCache={},_ghKeys=[];
function ghSection(u){
  var key=u.toFixed(5),hit=_ghCache[key];
  if(hit)return hit;
  var z=ghZ(u),W=ghW(z),dip=ghDip(u),yB=ghBase(z)-dip,yR=roofY(z)-dip,h=Math.max(0.02,yR-yB);
  var P=[[W,yB],[0.992*W,yB+0.30*h],[0.935*W,yB+0.63*h],[0.735*W,yB+0.90*h],[0.400*W,yR],[0,yR]];
  var pts=[],i;
  for(i=0;i<P.length;i++)pts.push(new T.Vector3(P[i][0],P[i][1],0));
  for(i=P.length-2;i>=0;i--)pts.push(new T.Vector3(-P[i][0],P[i][1],0));
  var cv=new T.CatmullRomCurve3(pts,false,'catmullrom',0.5);
  var sp=cv.getPoints(160);
  _ghCache[key]=sp;_ghKeys.push(key);
  if(_ghKeys.length>600){delete _ghCache[_ghKeys.shift()];}
  return sp;
}
function ghVf(u,f){
  var s=ghSection(u),n=s.length-1,z=ghZ(u);
  var dip=ghDip(u),yB=ghBase(z)-dip,yR=roofY(z)-dip;
  var ty=yB+f*(yR-yB),half=Math.floor(n/2),i,best=0,bd=1e9;
  for(i=0;i<=half;i++){
    var d=Math.abs(s[i].y-ty);if(d<bd){bd=d;best=i;}
    if(i>0){
      var y0=s[i-1].y,y1=s[i].y;                 /* interpolate - a quantised v folds the strip */
      if((y0-ty)*(y1-ty)<=0&&y0!==y1)return (i-1+(ty-y0)/(y1-y0))/n;
    }
  }
  return best/n;
}
/* inverse of the canopy section: v at a given x (section is monotone in x) */
function ghVx(u,x){
  var s=ghSection(u),n=s.length-1,i;
  for(i=0;i<n;i++){
    var x0=s[i].x,x1=s[i+1].x;
    if((x0-x)*(x1-x)<=0&&x0!==x1)return (i+(x-x0)/(x1-x0))/n;
  }
  return x>0?0:1;
}
function ghSurf(u,v){
  var s=ghSection(u),n=s.length-1,f=clamp(v,0,1)*n,i=Math.min(n-1,Math.floor(f)),t=f-i;
  return new T.Vector3(lerp(s[i].x,s[i+1].x,t),lerp(s[i].y,s[i+1].y,t),ghZ(u));
}
/* ---- the door's side window, punched out of the canopy ---- */
var _gwU=-1,_gwLo=0,_gwHi=0;
function winLim(u){
  if(u!==_gwU){_gwU=u;_gwLo=ghVf(u,DOOR.wf0);_gwHi=ghVf(u,DOOR.wf1);}
}
function winLo(u){winLim(u);return _gwLo;}
function winHi(u){winLim(u);return _gwHi;}
/* quads the canopy must not emit (u,v in greenhouse coordinates) */
function winSkip(u,v){
  if(u<=DOOR.wu0||u>=DOOR.wu1)return false;
  winLim(u);
  return (v>_gwLo&&v<_gwHi)||(v>1-_gwHi&&v<1-_gwLo);
}
/* once round the window opening, for the frame that carries the glass */
function winPerim(t,sg){
  var u,f;
  if(t<0.40){u=lerp(DOOR.wu0,DOOR.wu1,t/0.40);f=DOOR.wf0;}
  else if(t<0.50){u=DOOR.wu1;f=lerp(DOOR.wf0,DOOR.wf1,(t-0.40)/0.10);}
  else if(t<0.90){u=lerp(DOOR.wu1,DOOR.wu0,(t-0.50)/0.40);f=DOOR.wf1;}
  else{u=DOOR.wu0;f=lerp(DOOR.wf1,DOOR.wf0,(t-0.90)/0.10);}
  var v=ghVf(u,f);
  return [u,sg<0?1-v:v];
}


/* ================= SURFACE RELIEF =================
   Openings have to be sculpted into the skin itself - a patch that merely
   sinks below an intact shell would be hidden by it.                      */
function num(q,t){return typeof q==='function'?q(t):q;}
var FACECUT={f:[],r:[]},BODYCUT=[];
function faceCut(front,c){FACECUT[front?'f':'r'].push(c);return c;}
function faceRelief(front,x,y){
  var L=FACECUT[front?'f':'r'],t=0,i;
  for(i=0;i<L.length;i++){
    var c=L[i],xa=Math.min(c.x0,c.x1),xb=Math.max(c.x0,c.x1);
    if(x<xa-0.001||x>xb+0.001)continue;
    var q=(x-c.x0)/(c.x1-c.x0),s=c.s||0.05;
    var y0=num(c.y0,q),y1=num(c.y1,q);
    var fx=Math.min(smoothstep(0,s,x-xa),smoothstep(0,s,xb-x));
    var fy=Math.min(smoothstep(0,s,y-y0),smoothstep(0,s,y1-y));
    if(fx>0&&fy>0)t+=c.d*fx*fy;
  }
  return t;
}
function bodyRelief(u,v){
  var t=0,i;
  for(i=0;i<BODYCUT.length;i++){
    var c=BODYCUT[i];
    if(u<c.u0-0.001||u>c.u1+0.001)continue;
    var fu=Math.min(smoothstep(0,c.su,u-c.u0),smoothstep(0,c.su,c.u1-u));
    var fv=Math.min(smoothstep(0,c.sv,v-c.v0),smoothstep(0,c.sv,c.v1-v));
    if(fu>0&&fv>0)t+=c.d*fu*fv;
  }
  return t;
}
/* wrap a surface so it carries the relief (plus an optional extra offset) */
function reliefFn(fn,depthAt,extra){
  var e=0.0022;
  return function(u,v){
    var p=fn(u,v),d=depthAt(p,u,v);
    if(extra)d+=extra;
    if(d===0)return p;
    var pu=fn(Math.min(1,u+e),v).sub(fn(Math.max(0,u-e),v));
    var pv=fn(u,Math.min(1,v+e)).sub(fn(u,Math.max(0,v-e)));
    var n=pu.cross(pv);
    if(n.lengthSq()<1e-12)return p;
    return p.addScaledVector(n.normalize(),d);
  };
}
function faceReliefFn(front,fn,extra){
  return reliefFn(fn,function(p){return faceRelief(front,p.x,p.y);},extra);
}
function bodyReliefFn(fn,extra){
  return reliefFn(fn,function(p,u,v){return bodyRelief(u,v);},extra);
}
var bodySkin=function(u,v){return bodySurf(u,v);};

/* ---- nose / tail caps (the fascia surfaces) ---- */
var _capF=null,_capR=null;
function capSurf(front){
  if(front&&_capF)return _capF;
  if(!front&&_capR)return _capR;
  var uE=front?0:1,s=section(uE),cy=0,k,dir=front?1:-1;
  for(k=0;k<s.length;k++)cy+=s[k].y;
  cy/=s.length;
  var z=zAt(uE),bulge=front?0.085:0.070;
  var f=function(u,v){
    var p=bodySurf(uE,front?-v:v),c=Math.cos(clamp(u,0,1)*PI/2);
    return new T.Vector3(p.x*c,cy+(p.y-cy)*c,z+dir*bulge*Math.sin(clamp(u,0,1)*PI/2));
  };
  f.cy=cy;f.z=z;
  if(front)_capF=f;else _capR=f;
  return f;
}

/* ================= BODY ASSEMBLY ================= */
function mesh(geo,mat,cast,recv){
  var m=new T.Mesh(geo,mat);m.castShadow=cast!==false;m.receiveShadow=recv!==false;return m;
}
var _bn=new T.Vector3();
function bodyNormal(u,v){
  var e=0.0022;
  var pu=bodySurf(Math.min(1,u+e),v).sub(bodySurf(Math.max(0,u-e),v));
  var pv=bodySurf(u,v+0.0022).sub(bodySurf(u,v-0.0022));
  var n=pu.cross(pv);
  return n.lengthSq()<1e-12?_bn.set(0,1,0):n.normalize();
}
/* thin inset strip running lengthwise (panel gap / character line) */
function stripU(u0,u1,vFn,width,depth,mat,seg){
  var f=function(u,v){
    var U=lerp(u0,u1,u),V=vFn(U)+(v-0.5)*width;
    return bodySurf(U,V).addScaledVector(bodyNormal(U,V),depth);
  };
  return mesh(buildSurface(f,seg||70,3),mat,false,false);
}
/* thin inset strip running around the section (door gap) */
function stripV(u,v0,v1,width,depth,mat,seg){
  var f=function(a,b){
    var U=u+(a-0.5)*width,V=lerp(v0,v1,b);
    return bodySurf(U,V).addScaledVector(bodyNormal(U,V),depth);
  };
  return mesh(buildSurface(f,3,seg||46),mat,false,false);
}
function bodyPatch(u0,u1,v0,v1,off,mat,su,sv,cast){
  return mesh(buildSurface(patch(bodySurf,u0,u1,v0,v1,off),su||24,sv||24),mat,cast!==false,true);
}

/* ---- the door aperture, and the door that plugs it ----------------
   Both are sampled from the very same body surface as the shell, so the
   panel sits on the skin by construction however the shell is reshaped. */
/* mode 0: the door panel's outline (hangs lower, over the rocker)
   mode 1: the aperture's outer edge      mode 2: its edge on the cabin wall */
function doorPerim(t,sg,pu,pv,mode){
  var u,v,lo=mode===2?doorCutIn:(mode?doorCut:doorLo),hi=mode===2?doorHiIn:doorHi;
  pu=pu||0;pv=pv||0;
  var a=DOOR.u0-pu,b=DOOR.u1+pu;
  if(t<0.4){u=lerp(a,b,t/0.4);v=lo(u)-pv;}
  else if(t<0.5){u=b;v=lerp(lo(u)-pv,hi(u)+pv,(t-0.4)/0.1);}
  else if(t<0.9){u=lerp(b,a,(t-0.5)/0.4);v=hi(u)+pv;}
  else{u=a;v=lerp(hi(u)+pv,lo(u)-pv,(t-0.9)/0.1);}
  return {u:u,v:sg<0?1-v:v};
}
function buildAperture(sg){
  var G=new T.Group();
  /* the frame: a ruled surface joining the cut in the outer skin to the cut
     in the cabin wall. That is the whole opening - its bottom run is the sill
     you step over, and nothing else stands in the way. */
  G.add(mesh(buildSurface(function(a,b){
    var qo=doorPerim(b,sg,0,0,1),qi=doorPerim(b,sg,0,0,2);
    return bodySurf(qo.u,qo.v).lerp(bodySurf(qi.u,qi.v),a);
  },4,104,{closedV:true}),MAT.inner,false,true));
  return G;
}
function buildDoor(sg){
  var pivot=new T.Group(),G=new T.Group();
  var H=DOOR.hinge;
  pivot.position.set(sg*H[0],H[1],H[2]);
  G.position.set(-sg*H[0],-H[1],-H[2]);      /* geometry stays in car space */
  pivot.add(G);
  var PU=0.0050,PV=0.0058;                   /* overlap the cut edge by ~a quad */
  /* on the -X flank v runs backwards, so walk b the other way and the
     winding of every door surface matches the shell it plugs */
  var uv=function(a,b){
    var U=lerp(DOOR.u0-PU,DOOR.u1+PU,a);
    var V=lerp(doorLo(U)-PV,doorHi(U)+PV,sg>0?b:1-b);
    return [U,sg<0?1-V:V];
  };
  var skin=function(a,b){var q=uv(a,b);return bodySurf(q[0],q[1]);};
  /* 1.6 mm proud, so the overlap band cannot fight the shell for depth - but
     faded out over the top edge, because the panel now wraps the shoulder
     crest and a proud lip on that fold caught the light as a long white line
     down the door. */
  G.add(mesh(buildSurface(reliefFn(skin,function(p,a,b){
    var q=uv(a,b);
    return bodyRelief(q[0],q[1])+0.0016*smoothstep(1,0.88,sg>0?b:1-b);
  }),sg(64),sg(26)),MAT.paint));
  G.add(mesh(buildSurface(offsetFn(skin,-0.090),64,26,{flip:true}),MAT.alcantara,false,true));
  G.add(mesh(buildSurface(function(a,b){
    var q=doorPerim(b,sg,PU,PV);
    return bodySurf(q.u,q.v).addScaledVector(bodyNormal(q.u,q.v),0.0016-0.0918*a);
  },2,104,{closedV:true}),MAT.inner,false,false));
  /* the door's length of the character line, so it travels with the panel */
  G.add(stripU(DOOR.u0-PU,DOOR.u1+PU,
    sg>0?creaseV:function(u){return 1-creaseV(u);},0.0320,0.0026,MAT.crease,54));
  /* the shut line, carried on the door so the gap opens with it */
  [DOOR.u0-PU,DOOR.u1+PU].forEach(function(u){
    var a=doorLo(u)-PV,b=doorHi(u)+PV;
    if(sg<0){a=1-a;b=1-b;}
    G.add(stripV(u,a,b,0.0026,-0.0008,MAT.gap,54));
  });
  /* the side window and its frame ride on the door, so the opening runs in
     one piece from the sill to the roof rail */
  var fLo=function(U){return sg>0?winLo(U):1-winHi(U);};
  var fHi=function(U){return sg>0?winHi(U):1-winLo(U);};
  G.add(mesh(buildSurface(patchV(ghSurf,DOOR.wu0,DOOR.wu1,fLo,fHi),46,26),
    MAT.glassBoth,false,false));
  var wp=[],wi;
  for(wi=0;wi<=80;wi++)wp.push(winPerim(wi/80,sg));
  G.add(tubeOn(ghSurf,wp,0.0115,MAT.pillar,0.004));

  /* ---- the door card ----------------------------------------------
     Swung open, the inside of the door is as much on show as the outside,
     and an unbroken sheet of trim reads as a blank slab. Give it the
     things a door actually has, all sat on the card's own surface. */
  var card=function(z,y,inw){                 /* a point on the inner face */
    var u=uAt(z),v=vOuter(u,y);if(sg<0)v=1-v;
    var fr=frameAt(bodySurf,u,v);
    return {p:fr.p.addScaledVector(fr.n,-0.090-inw),n:fr.n};
  };
  var put=function(g,mat,z,y,inw,rot){
    var m=mesh(g,mat,false,false),c=card(z,y,inw);
    m.position.copy(c.p);
    m.rotation.set(rot?rot[0]:0,rot?rot[1]:0,rot?rot[2]:0);
    G.add(m);return m;
  };
  /* uv() walks b backwards on the -X flank to keep the winding, so a height
     has to be pre-flipped or the waist roll lands down at the sill */
  var H=function(h){return sg>0?h:1-h;};
  /* a contrast insert across the middle, so the card is not one flat sheet.
     H() walks b backwards on the -X flank, which flips the cross product
     offsetFn takes its direction from - so the insert was pushed 10 cm the
     wrong way and stood outside the door as a black slab. bodySurf's own
     normal faces out of the shell whichever flank it is sampled on. */
  G.add(mesh(buildSurface(function(a,b){
    var q=uv(lerp(0.10,0.90,a),lerp(H(0.24),H(0.66),b));
    return bodySurf(q[0],q[1]).addScaledVector(bodyNormal(q[0],q[1]),-0.102);
  },34,14,{flip:true}),MAT.carbon,false,false));
  /* waist roll along the top of the card */
  G.add(mesh(buildSurface(offsetFn(function(a,b){
    var q=uv(lerp(0.03,0.97,a),lerp(H(0.86),H(0.99),b));return bodySurf(q[0],q[1]);
  },-0.084),40,4,{flip:true}),MAT.leather,false,false));
  put(roundedBox(0.070,0.090,0.520,0.030,9),MAT.leather,-0.13,0.700,0.030);
  put(roundedBox(0.048,0.070,0.215,0.020,8),MAT.satin, 0.06,0.815,0.044);
  put(roundedBox(0.055,0.115,0.400,0.026,8),MAT.matte, -0.10,0.375,0.026);
  var sp=put(new T.CylinderGeometry(0.076,0.076,0.014,20),MAT.mesh,0.30,0.455,0.014);
  sp.rotation.z=PI/2;
  pivot.userData.skin=G;
  return pivot;
}

function buildBody(){
  var G=new T.Group(),i;

  /* ---- main shell (with both door apertures punched out) ---- */
  var shell=mesh(buildSurface(bodyReliefFn(bodySurf,0),sg(220),sg(190),{closedV:true,skip:doorSkip}),MAT.paint);
  G.add(shell);

  /* ---- what the open aperture reveals: a rebate around the cut edge,
     and a lip along its bottom edge ---- */
  [1,-1].forEach(function(sg){G.add(buildAperture(sg));});

  /* ---- nose & tail caps ---- */
  [true,false].forEach(function(front){
    G.add(mesh(buildSurface(faceReliefFn(front,capSurf(front),0),sg(40),sg(200),{closedV:true}),MAT.paint));
  });

  /* ---- cabin liner (interior trim over the tub) ---- */
  var uC0=uAt(0.60),uC1=uAt(-1.08);
  G.add(mesh(buildSurface(patch(bodySurf,uC0,uC1,0.345,0.655,0.008),sg(90),sg(60),
    {skip:function(a,v){return doorSkip(lerp(uC0,uC1,a),lerp(0.345,0.655,v));}}),
    MAT.alcantara,false,true));

  /* ---- wheel-arch liners ---- */
  [[CAR.axF,CAR.archF,CAR.rF,CAR.trF,0.20],[CAR.axR,CAR.archR,CAR.rR,CAR.trR,0.235]].forEach(function(w){
    var ax=w[0],ra=w[1],yc=w[2],tr=w[3],hw=w[4];
    [1,-1].forEach(function(sg){
      var f=function(u,v){
        var a=PI*(-0.585+1.17*v);
        return new T.Vector3(sg*(tr+(u-0.5)*2*hw),yc+Math.cos(a)*(ra-0.022),ax+Math.sin(a)*(ra-0.022));
      };
      G.add(mesh(buildSurface(f,3,26),MAT.well,false,false));
    });
  });

  /* ---- panel gaps ---- */
  var gapM=MAT.gap;
  /* bonnet: two lines + cowl line */
  var hoodV=function(u){return vDeck(u,0.70*halfW(zAt(u)));};
  var hu0=uAt(2.02),hu1=uAt(0.725);
  G.add(stripU(hu0,hu1,hoodV,0.0022,0.0006,gapM,110));
  G.add(stripU(hu0,hu1,function(u){return 1-hoodV(u);},0.0022,0.0006,gapM,110));
  G.add(stripV(hu1,hoodV(hu1),1-hoodV(hu1),0.0022,0.0006,gapM,70));
  /* (the door gaps travel with the door - see buildDoor) */
  /* boot lid */
  var bu0=uAt(-1.58),bu1=uAt(-2.02);
  var bootV=function(u){return vDeck(u,0.66*halfW(zAt(u)));};
  G.add(stripU(bu0,bu1,bootV,0.0022,0.0006,gapM,50));
  G.add(stripU(bu0,bu1,function(u){return 1-bootV(u);},0.0022,0.0006,gapM,50));
  G.add(stripV(bu0,bootV(bu0),1-bootV(bu0),0.0022,0.0006,gapM,70));

  /* ---- character line along the flanks ----
     Broken either side of the door: it runs at the height of the opening, so
     an unbroken strip laid straight across it - a body-coloured panel stuck
     in the doorway. The door carries its own segment (see buildDoor). */
  var chR=function(u){return 1-creaseV(u);};
  [[uAt(1.76),DOOR.u0-0.005,60],[DOOR.u1+0.005,uAt(-1.70),60]].forEach(function(r){
    G.add(stripU(r[0],r[1],creaseV,0.0320,0.0026,MAT.crease,r[2]));
    G.add(stripU(r[0],r[1],chR,0.0320,0.0026,MAT.crease,r[2]));
  });

  /* ---- side skirts ---- */
  var skV=function(u){return vOuter(u,sillY(zAt(u))+0.045);};
  [1,-1].forEach(function(sg){
    var f=function(u,v){
      var U=lerp(uAt(1.34),uAt(-1.38),u),c=skV(U);
      if(sg<0)c=1-c;
      var V=c+(v-0.5)*sg*0.016;
      return bodySurf(U,V).addScaledVector(bodyNormal(U,V),0.013);
    };
    G.add(mesh(buildSurface(f,80,6),MAT.carbon,true,false));
  });

  return G;
}

/* ================= GREENHOUSE ================= */
function buildGreenhouse(){
  var G=new T.Group();
  /* glass canopy */
  var glass=mesh(buildSurface(patch(ghSurf,GH.u0,GH.u1,0,1),sg(132),sg(96),
    {skip:function(a,v){return winSkip(lerp(GH.u0,GH.u1,a),v);}}),MAT.glass,false,false);
  glass.renderOrder=6;G.add(glass);
  var RE=function(u){return ghVf(u,0.86);};       /* roof shoulder */
  var RE2=function(u){return 1-RE(u);};
  /* roof panel */
  G.add(mesh(buildSurface(fadeOffsetFn(patchV(ghSurf,0.215,0.735,RE,RE2),0.013,0.10),sg(64),sg(40)),MAT.paint));
  /* A pillars (edge of the windscreen) */
  [1,-1].forEach(function(sg){
    var a=function(u){var q=ghVf(u,0.40);return sg>0?q:1-q;};
    var b=function(u){var q=ghVf(u,0.71);return sg>0?q:1-q;};
    G.add(mesh(buildSurface(fadeOffsetFn(patchV(ghSurf,GH.u0,0.235,a,b),0.006,0.18),34,14),MAT.pillar));
  });
  /* rear quarter panels */
  [1,-1].forEach(function(sg){
    var a=function(u){return sg>0?0:1;};
    var b=function(u){var q=ghVf(u,0.66);return sg>0?q:1-q;};
    G.add(mesh(buildSurface(fadeOffsetFn(patchV(ghSurf,0.610,GH.u1,a,b),0.010,0.12),38,16),MAT.paint));
  });
  /* window surround trim - split around the door window, which the door
     frames for itself */
  [1,-1].forEach(function(sg){
    var a=function(u){return sg>0?0:1;};
    var b=function(u){var q=ghVf(u,0.135);return sg>0?q:1-q;};
    [[GH.u0,DOOR.wu0],[DOOR.wu1,GH.u1]].forEach(function(r){
      G.add(mesh(buildSurface(fadeOffsetFn(patchV(ghSurf,r[0],r[1],a,b),0.007,0.20),34,5),MAT.pillar,false));
    });
  });
  /* shark-fin antenna */
  var fs=new T.Shape();
  fs.moveTo(-0.132,0);fs.quadraticCurveTo(-0.055,0.062,0.062,0.082);
  fs.quadraticCurveTo(0.118,0.084,0.132,0);fs.lineTo(-0.132,0);
  var fg=new T.ExtrudeGeometry(fs,{depth:0.028,bevelEnabled:true,bevelSize:0.008,bevelThickness:0.008,
    bevelSegments:2,curveSegments:14});
  fg.translate(0,0,-0.014);fg.rotateY(PI/2);
  var fin=mesh(fg,MAT.gloss);
  var fr=frameAt(ghSurf,0.655,0.5);
  fin.position.copy(fr.p).addScaledVector(fr.n,0.026);
  G.add(fin);
  /* ---- wipers: parked tandem pair, hugging the glass ---- */
  function wiperPath(x0,x1,u0,u1,n){
    var pts=[],i;
    for(i=0;i<=n;i++){var t=i/n,u=clamp(lerp(u0,u1,t),0.004,0.99);pts.push([u,ghVx(u,lerp(x0,x1,t))]);}
    return pts;
  }
  function wiper(xPivot,xTip,uPivot,uTip){
    var W=new T.Group();
    var spine=wiperPath(xPivot,xTip,uPivot,uTip,20);
    /* rubber blade sits on the glass, the spine rides just above it */
    W.add(tubeOn(ghSurf,spine.slice(3),0.0052,MAT.rubber,0.009));
    W.add(tubeOn(ghSurf,spine.slice(3),0.0062,MAT.gloss,0.021));
    /* claws linking spine to blade */
    [0.30,0.55,0.80].forEach(function(t){
      var k=spine[Math.round(3+(spine.length-4)*t)];
      var f=frameAt(ghSurf,k[0],k[1]);
      var cl=mesh(roundedBox(0.010,0.019,0.026,0.004,6),MAT.gloss,false,false);
      orientTo(cl,f.p.addScaledVector(f.n,0.015),f.n);W.add(cl);
    });
    /* arm: pivot boss on the cowl, tapered arm reaching the blade */
    var armPts=wiperPath(xPivot,lerp(xPivot,xTip,0.44),uPivot-0.012,lerp(uPivot,uTip,0.44),12);
    W.add(tubeOn(ghSurf,armPts,0.0105,MAT.gloss,0.029));
    var pu=Math.max(0.008,uPivot-0.014),pf=frameAt(ghSurf,pu,ghVx(pu,xPivot));
    var boss=mesh(new T.CylinderGeometry(0.021,0.025,0.026,18),MAT.gloss,false,false);
    boss.rotation.x=PI/2;
    orientTo(boss,pf.p.addScaledVector(pf.n,0.020),pf.n);W.add(boss);
    var cap=mesh(new T.CylinderGeometry(0.011,0.011,0.010,14),MAT.satin,false,false);
    cap.rotation.x=PI/2;
    orientTo(cap,pf.p.addScaledVector(pf.n,0.034),pf.n);W.add(cap);
    return W;
  }
  G.add(wiper(0.500,-0.020,0.013,0.038));   /* driver side */
  G.add(wiper(-0.058,-0.520,0.013,0.038));  /* passenger side */
  return G;
}

/* ================= WHEELS ================= */
function discTexture(){
  var c=cvs(512,512),x=c.getContext('2d');
  x.fillStyle='#5b616b';x.fillRect(0,0,512,512);
  var g=x.createRadialGradient(256,256,60,256,256,256);
  g.addColorStop(0,'#3a3e46');g.addColorStop(.34,'#787f8a');g.addColorStop(.9,'#666d78');g.addColorStop(1,'#43474e');
  x.fillStyle=g;x.beginPath();x.arc(256,256,256,0,PI*2);x.fill();
  /* turned finish */
  x.strokeStyle='rgba(255,255,255,.05)';x.lineWidth=1;
  for(var r=70;r<250;r+=3){x.beginPath();x.arc(256,256,r,0,PI*2);x.stroke();}
  /* drilled holes */
  for(var ring=0;ring<3;ring++){
    var rr=125+ring*38,n=18+ring*4;
    for(var i=0;i<n;i++){
      var a=i/n*PI*2+ring*0.22,px=256+Math.cos(a)*rr,py=256+Math.sin(a)*rr;
      x.fillStyle='#15181c';x.beginPath();x.arc(px,py,7,0,PI*2);x.fill();
      x.strokeStyle='rgba(255,255,255,.28)';x.lineWidth=1.6;x.stroke();
    }
  }
  /* slots */
  x.strokeStyle='#2b2f35';x.lineWidth=9;
  for(var s=0;s<8;s++){
    var a0=s/8*PI*2;
    x.beginPath();x.arc(256,256,200,a0,a0+0.42);x.stroke();
  }
  x.fillStyle='#2d3138';x.beginPath();x.arc(256,256,104,0,PI*2);x.fill();
  return c;
}
function caliperTexture(){
  var c=cvs(256,64),x=c.getContext('2d');
  x.fillStyle='#c21c33';x.fillRect(0,0,256,64);
  x.fillStyle='#fff';x.font='bold 30px Arial';x.textAlign='center';x.textBaseline='middle';
  x.fillText('A V I R',128,34);
  return c;
}
var _discMap=null,_calMap=null;
function buildWheel(front){
  var R=front?CAR.rF:CAR.rR, HW=front?CAR.hwF:CAR.hwR, RR=0.246;
  var pivot=new T.Group(), spin=new T.Group(), fixed=new T.Group();
  pivot.add(spin);pivot.add(fixed);
  if(!_discMap){_discMap=tex(discTexture(),1,1);_calMap=tex(caliperTexture(),1,1);}

  /* tyre */
  var prof=[[-HW,RR],[-HW*1.005,RR+0.045],[-HW*0.99,R*0.80],[-HW*0.94,R*0.935],[-HW*0.82,R*0.993],
    [-HW*0.55,R],[0,R*1.003],[HW*0.55,R],[HW*0.82,R*0.993],[HW*0.94,R*0.935],[HW*0.99,R*0.80],
    [HW*1.005,RR+0.045],[HW,RR]];
  spin.add(mesh(revolveX(prof,72),MAT.tyre));

  /* rim barrel + lip */
  spin.add(mesh(revolveX([[-HW*0.92,RR-0.004],[-HW*0.55,RR-0.030],[HW*0.30,RR-0.030],
    [HW*0.72,RR-0.018],[HW*0.90,RR-0.004],[HW*1.0,RR+0.006],[HW*0.94,RR+0.010]],56),MAT.rim));
  var lip=mesh(revolveX([[HW*0.86,RR-0.030],[HW*0.98,RR-0.020],[HW*1.005,RR-0.004]],56),MAT.chrome);
  spin.add(lip);

  /* spokes */
  var sh=new T.Shape();
  sh.moveTo(0.064,0.052);sh.lineTo(0.135,0.046);sh.lineTo(0.228,0.092);
  sh.lineTo(0.238,0.048);sh.lineTo(0.238,-0.048);sh.lineTo(0.228,-0.092);
  sh.lineTo(0.135,-0.046);sh.lineTo(0.064,-0.052);sh.closePath();
  var hole=new T.Path();
  hole.moveTo(0.150,0);hole.lineTo(0.222,0.056);hole.lineTo(0.222,-0.056);hole.closePath();
  sh.holes.push(hole);
  var sg=new T.ExtrudeGeometry(sh,{depth:0.052,bevelEnabled:true,bevelThickness:0.007,
    bevelSize:0.007,bevelSegments:2,curveSegments:6,steps:1});
  sg.translate(0,0,-0.052);sg.rotateY(-PI/2);
  for(var i=0;i<5;i++){
    var sp=mesh(sg,MAT.rim);
    sp.rotation.x=i/5*PI*2;
    sp.position.x=HW*0.90-0.052;
    spin.add(sp);
  }
  /* hub + centre cap + bolts */
  var hub=mesh(revolveX([[HW*0.30,0.030],[HW*0.55,0.082],[HW*0.86,0.086],[HW*0.90,0.070]],40),MAT.rim);
  spin.add(hub);
  var cap=mesh(new T.CircleGeometry(0.048,32),MAT.logo,false,false);
  cap.rotation.y=PI/2;cap.position.x=HW*0.905;spin.add(cap);
  var boltG=new T.CylinderGeometry(0.0115,0.0115,0.018,10);
  boltG.rotateZ(PI/2);
  for(var b=0;b<5;b++){
    var bo=mesh(boltG,MAT.satin,false,false);
    bo.position.set(HW*0.855,Math.cos(b/5*PI*2+0.6)*0.070,Math.sin(b/5*PI*2+0.6)*0.070);
    spin.add(bo);
  }
  /* valve */
  var vg=new T.CylinderGeometry(0.006,0.006,0.032,8);vg.rotateZ(PI/2);
  var vv=mesh(vg,MAT.satin,false,false);
  vv.position.set(HW*0.88,0.148,0.10);spin.add(vv);

  /* brake disc */
  var dR=front?0.196:0.184;
  var dg=new T.CylinderGeometry(dR,dR,0.028,54,1,false);
  dg.rotateZ(PI/2);
  var disc=new T.Mesh(dg,[
    new T.MeshStandardMaterial({color:0x4a4e56,metalness:1,roughness:0.45}),
    new T.MeshStandardMaterial({map:_discMap,metalness:1,roughness:0.34}),
    new T.MeshStandardMaterial({map:_discMap,metalness:1,roughness:0.34})]);
  disc.castShadow=true;disc.position.x=HW*0.24;spin.add(disc);
  var hat=mesh(revolveX([[HW*0.24,0.062],[HW*0.55,0.070],[HW*0.62,0.062]],32),MAT.satin,false,false);
  spin.add(hat);

  /* caliper (does not spin) */
  var cal=new T.Group();
  var body=mesh(roundedBox(0.062,0.115,0.235,0.020,10),MAT.caliper);
  cal.add(body);
  var deco=new T.Mesh(new T.PlaneGeometry(0.20,0.05),new T.MeshStandardMaterial({map:_calMap,roughness:0.3,metalness:0.2}));
  deco.rotation.y=PI/2;deco.position.set(0.032,0.004,0);cal.add(deco);
  var brg=new T.BoxGeometry(0.052,0.030,0.19);
  var br1=mesh(brg,MAT.matte,false,false);br1.position.set(0,-0.070,0);cal.add(br1);
  var th=front?0.62:-0.62,r0=dR-0.030;
  cal.position.set(HW*0.24,Math.cos(th)*r0,Math.sin(th)*r0);
  cal.rotation.x=th;
  fixed.add(cal);

  return pivot;
}

/* ================= placement helpers ================= */
var LIGHTS={drl:[],head:[],tail:[],brake:[],rev:[],beams:[],spots:[]};
function putOn(fn,u,v,off,obj,up){
  var f=frameAt(fn,u,v);
  return orientTo(obj,f.p.addScaledVector(f.n,off||0),f.n,up);
}
/* inverse map: find (u,v) on a cap surface nearest to a target x/y */
function capUV(fn,x,y){
  var bu=0.5,bv=0,bd=1e9,i,j,p,d;
  for(i=0;i<=40;i++)for(j=0;j<80;j++){
    var u=i/40,v=j/80;p=fn(u,v);
    d=(p.x-x)*(p.x-x)+(p.y-y)*(p.y-y);
    if(d<bd){bd=d;bu=u;bv=v;}
  }
  for(var it=0;it<4;it++){
    var st=Math.pow(0.4,it+1);
    for(var a=-3;a<=3;a++)for(var b=-3;b<=3;b++){
      var u2=clamp(bu+a*st/16,0,1),v2=bv+b*st/20;p=fn(u2,v2);
      d=(p.x-x)*(p.x-x)+(p.y-y)*(p.y-y);
      if(d<bd){bd=d;bu=u2;bv=v2;}
    }
  }
  return[bu,bv];
}
function tubeOn(fn,pts,r,mat,off){
  var vs=[],i;
  for(i=0;i<pts.length;i++){
    var f=frameAt(fn,pts[i][0],pts[i][1]);
    vs.push(f.p.addScaledVector(f.n,off===undefined?0.012:off));
  }
  var cv=new T.CatmullRomCurve3(vs,false,'catmullrom',0.3);
  return mesh(new T.TubeGeometry(cv,48,r,10,false),mat,false,false);
}
function dishPatch(fn,u0,u1,v0,v1,depth,mat,su,sv,soft){
  return mesh(buildSurface(dishFn(patch(fn,u0,u1,v0,v1),depth,soft||0.20),su||30,sv||30),mat,false,true);
}


/* ================= FASCIA MAPPING =================
   The nose / tail caps are polar surfaces, so lay features out in real
   (x,y) face coordinates and project them onto the cap.                */
var _fmap={};
function faceMap(front){
  var key=front?'f':'r';
  if(_fmap[key])return _fmap[key];
  var fn=capSurf(front),cy=fn.cy,uE=front?0:1,s=section(uE),n=s.length;
  var ang=new Float64Array(n),rad=new Float64Array(n),i;
  for(i=0;i<n;i++){
    var px=front?-s[i].x:s[i].x,py=s[i].y-cy;
    ang[i]=Math.atan2(py,px);rad[i]=Math.sqrt(px*px+py*py);
  }
  var f=function(x,y){
    var a=Math.atan2(y-cy,x),R=Math.sqrt(x*x+(y-cy)*(y-cy)),i,k=-1,t=0,best=0,bd=9;
    for(i=0;i<n;i++){
      var a0=ang[i],a1=ang[(i+1)%n];
      var d=a1-a0;while(d>PI)d-=2*PI;while(d<-PI)d+=2*PI;
      var da=a-a0;while(da>PI)da-=2*PI;while(da<-PI)da+=2*PI;
      if(Math.abs(d)>1e-9){var r=da/d;if(r>=0&&r<=1){k=i;t=r;break;}}
      var ad=Math.abs(da);if(ad<bd){bd=ad;best=i;}
    }
    if(k<0){k=best;t=0;}
    var rr=lerp(rad[k],rad[(k+1)%n],t);
    var c=clamp(R/Math.max(1e-4,rr),0,1);
    return fn(Math.acos(c)*2/PI,(k+t)/n);
  };
  f.cy=cy;_fmap[key]=f;return f;
}
/* rectangle in face coordinates; y0/y1 may be functions of the horizontal param */
function facePatch(front,x0,x1,y0,y1){
  var f=faceMap(front);
  return function(u,v){
    var t=front?u:v,w=front?v:u;
    var xx=lerp(x0,x1,t);
    return f(xx,lerp(num(y0,t),num(y1,t),w));
  };
}
function faceFrame(front,x,y){
  var f=faceMap(front),e=0.012;
  var p=f(x,y);
  var px=f(x+e,y).sub(f(x-e,y)),py=f(x,y+e).sub(f(x,y-e));
  var n=px.cross(py).normalize();
  if(!front)n.negate();
  return {p:p,n:n};
}
function facePut(front,x,y,off,obj){
  var fr=faceFrame(front,x,y);
  return orientTo(obj,fr.p.addScaledVector(fr.n,off||0),fr.n);
}
function faceDish(front,x0,x1,y0,y1,depth,mat,su,sv,soft){
  return mesh(buildSurface(dishFn(facePatch(front,x0,x1,y0,y1),depth,soft||0.18),su||34,sv||26),mat,false,true);
}

/* ---- every opening in the skin, registered before the body is built ---- */
var CUT={};
function initCuts(){
  if(CUT.ready)return;CUT.ready=true;
  var mY1=function(t){return 0.496-0.058*Math.abs(2*t-1);};
  CUT.mouth=faceCut(true,{x0:-0.672,x1:0.672,y0:0.318,y1:mY1,d:-0.140,s:0.058});
  CUT.intake=[];CUT.lamp=[];
  [1,-1].forEach(function(sg){
    CUT.intake.push(faceCut(true,{x0:sg*0.690,x1:sg*0.880,y0:0.322,y1:0.486,d:-0.095,s:0.048}));
    CUT.lamp.push(faceCut(true,{x0:sg*0.305,x1:sg*0.795,
      y0:function(t){return 0.529-0.026*t;},y1:function(t){return 0.622+0.020*t;},d:-0.056,s:0.042}));
  });
  CUT.bar=faceCut(false,{x0:-0.800,x1:0.800,
    y0:function(t){return 0.590+0.022*(1-Math.abs(2*t-1));},
    y1:function(t){return 0.702+0.020*(1-Math.abs(2*t-1));},d:-0.058,s:0.042});
  CUT.diff=faceCut(false,{x0:-0.640,x1:0.640,y0:0.300,
    y1:function(t){return 0.458-0.030*Math.abs(2*t-1);},d:-0.120,s:0.055});
  CUT.vent=[];CUT.handle=[];
  [1,-1].forEach(function(sg){
    /* the intake sits clear behind the door's shut line and clear of the rear
       arch: over the arch the skin turns hard and the recess tore open */
    /* it has to fit between the door's shut line and the rear arch - 34 cm of
       skin. Wider than that and it either crosses the opening or tears where
       the surface turns into the arch. */
    var iu=uAt(-0.79),iv=vOuter(iu,0.660);if(sg<0)iv=1-iv;
    CUT.vent.push({u0:iu-0.029,u1:iu+0.029,v0:iv-0.015,v1:iv+0.015,d:-0.032,su:0.020,sv:0.008});
    var hu=uAt(0.06),hv=vOuter(hu,0.806);if(sg<0)hv=1-hv;
    CUT.handle.push({u0:hu-0.028,u1:hu+0.028,v0:hv-0.0075,v1:hv+0.0075,d:-0.021,su:0.009,sv:0.003});
  });
  var fu=uAt(-1.02),fv=1-vOuter(fu,0.756);
  CUT.fuel={u0:fu-0.011,u1:fu+0.011,v0:fv-0.011,v1:fv+0.011,d:-0.014,su:0.005,sv:0.004};
  BODYCUT.push(CUT.vent[0],CUT.vent[1],CUT.handle[0],CUT.handle[1],CUT.fuel);
}
function faceRect(front,c){return facePatch(front,c.x0,c.x1,c.y0,c.y1);}
function faceInset(front,c,extra,su,sv,mat,shadow){
  return mesh(buildSurface(faceReliefFn(front,faceRect(front,c),extra),su,sv),mat,false,shadow!==false);
}
function bodyRect(c){return function(u,v){return bodySurf(lerp(c.u0,c.u1,u),lerp(c.v0,c.v1,v));};}

/* ================= FRONT END ================= */
function buildFront(){
  var G=new T.Group(),NS=capSurf(true),i;

  /* ---- main intake ---- */
  var mouth=faceReliefFn(true,faceRect(true,CUT.mouth),0.004);
  G.add(mesh(buildSurface(mouth,58,30),MAT.mesh,false,true));
  /* horizontal blade inside the intake */
  G.add(mesh(buildSurface(patch(mouth,0.05,0.95,0.40,0.47,0.055),54,3),MAT.carbon,false,false));
  /* corner intakes */
  [1,-1].forEach(function(sg){
    var ci=faceReliefFn(true,faceRect(true,CUT.intake[sg>0?0:1]),0.004);
    G.add(mesh(buildSurface(ci,20,20),MAT.mesh,false,false));
    for(i=0;i<3;i++){
      var yy=0.16+i*0.28;
      G.add(mesh(buildSurface(patch(ci,0.08,0.92,yy,yy+0.075,0.042),12,3),MAT.gloss,false,false));
    }
  });

  /* ---- head lamps ---- */
  [1,-1].forEach(function(sg){
    var cl=CUT.lamp[sg>0?0:1];
    var hs=faceRect(true,cl);
    G.add(mesh(buildSurface(faceReliefFn(true,hs,0.003),36,22),MAT.matte,false,false));
    /* projectors */
    [0.33,0.63].forEach(function(pu){
      var f=frameAt(hs,pu,0.44);
      var holder=new T.Group();
      var bowl=mesh(revolveX([[-0.044,0.002],[-0.024,0.032],[-0.005,0.043],[0.003,0.045]],26),MAT.reflector,false,false);
      bowl.rotation.y=-PI/2;holder.add(bowl);
      var lens=mesh(new T.SphereGeometry(0.039,20,14,0,PI*2,0,PI*0.42),MAT.lensClear,false,false);
      lens.rotation.x=PI/2;lens.position.z=0.010;holder.add(lens);
      var bulb=mesh(new T.SphereGeometry(0.015,14,10),MAT.ledOff,false,false);
      bulb.position.z=-0.010;holder.add(bulb);
      LIGHTS.head.push(bulb);
      orientTo(holder,f.p.addScaledVector(f.n,-0.032),f.n);
      G.add(holder);
    });
    /* LED signature */
    var drl=tubeOn(hs,[[0.10,0.26],[0.34,0.19],[0.70,0.19],[0.90,0.30]],0.0105,MAT.ledOff,-0.014);
    G.add(drl);LIGHTS.drl.push(drl);
    var drl2=tubeOn(hs,[[0.13,0.80],[0.45,0.86],[0.87,0.79]],0.0075,MAT.ledOff,-0.014);
    G.add(drl2);LIGHTS.drl.push(drl2);
    /* clear cover */
    var cover=mesh(buildSurface(offsetFn(hs,0.005),30,16),MAT.lensClear,false,false);
    cover.renderOrder=4;G.add(cover);
    /* beam + spot */
    var cone=new T.Mesh(new T.ConeGeometry(0.78,6.4,28,1,true),
      new T.MeshBasicMaterial({color:0xcfe2ff,transparent:true,opacity:0.085,
        blending:T.AdditiveBlending,depthWrite:false,side:T.DoubleSide,fog:false}));
    cone.rotation.x=-PI/2;cone.position.set(sg*0.58,0.545,2.30+3.2);
    cone.visible=false;cone.renderOrder=9;
    G.add(cone);LIGHTS.beams.push(cone);
    var sp=new T.SpotLight(0xcfe0ff,0,22,0.44,0.60,1.1);
    sp.position.set(sg*0.58,0.57,2.28);
    sp.target.position.set(sg*1.05,0.0,7.2);
    G.add(sp);G.add(sp.target);LIGHTS.spots.push(sp);
  });

  /* ---- number plate ---- */
  var pg=new T.BoxGeometry(0.42,0.115,0.014);
  var pm=[MAT.trim,MAT.trim,MAT.trim,MAT.trim,MAT.plateF,MAT.trim];
  G.add(facePut(true,0,0.560,0.012,new T.Mesh(pg,pm)));
  /* tow hook cover */
  G.add(facePut(true,0.560,0.360,0.004,mesh(new T.CircleGeometry(0.030,18),MAT.trim,false,false)));

  /* ---- bonnet badge ---- */
  var lg=new T.Mesh(new T.CircleGeometry(0.052,36),MAT.logo);
  lg.renderOrder=3;
  G.add(putOn(bodySurf,uAt(2.02),0.5,0.004,lg));

  /* ---- splitter ---- */
  var sp2=new T.Shape();
  sp2.moveTo(-0.865,-0.245);sp2.quadraticCurveTo(-0.50,-0.015,0,0.020);
  sp2.quadraticCurveTo(0.50,-0.015,0.865,-0.245);
  sp2.lineTo(0.815,-0.325);sp2.quadraticCurveTo(0,-0.120,-0.815,-0.325);sp2.closePath();
  var spg=new T.ExtrudeGeometry(sp2,{depth:0.026,bevelEnabled:true,bevelSize:0.006,bevelThickness:0.006,
    bevelSegments:2,curveSegments:20});
  spg.rotateX(PI/2);
  var spm=mesh(spg,MAT.carbon);
  spm.position.set(0,0.166,2.212);
  G.add(spm);
  [1,-1].forEach(function(sg){
    var cd=mesh(new T.BoxGeometry(0.105,0.013,0.215),MAT.carbon);
    cd.position.set(sg*0.815,0.292,2.128);cd.rotation.set(0.16,0,sg*0.13);
    G.add(cd);
  });
  return G;
}

/* ================= REAR END ================= */
function buildRear(){
  var G=new T.Group(),i;

  /* ---- full width light bar ---- */
  var barRect=faceRect(false,CUT.bar);
  var barDish=faceReliefFn(false,barRect,0.003);
  G.add(mesh(buildSurface(barDish,22,58),MAT.matte,false,false));
  var strip=mesh(buildSurface(patch(barDish,0.16,0.84,0.035,0.965,0.008),10,54),MAT.tailOff,false,false);
  G.add(strip);LIGHTS.tail.push(strip);
  var bl=mesh(buildSurface(patch(barDish,0.30,0.70,0.20,0.80,0.014),8,40),MAT.tailOff,false,false);
  G.add(bl);LIGHTS.brake.push(bl);
  var cov=mesh(buildSurface(offsetFn(barRect,0.005),12,56),MAT.lensRed,false,false);
  cov.renderOrder=4;G.add(cov);
  /* third brake light under the screen */
  var tb=mesh(roundedBox(0.34,0.022,0.03,0.008,6),MAT.tailOff,false,false);
  tb.position.set(0,0.966,-1.60);G.add(tb);LIGHTS.brake.push(tb);

  /* ---- diffuser ---- */
  var dDish=faceReliefFn(false,faceRect(false,CUT.diff),0.004);
  G.add(mesh(buildSurface(dDish,26,48),MAT.carbon,false,true));
  for(i=0;i<7;i++){
    var t=(i+0.5)/7;
    G.add(mesh(buildSurface(patch(dDish,0.10,0.94,t-0.010,t+0.010,0.058),10,3),MAT.carbon,false,false));
  }
  /* fog + reverse lamps */
  var fog=mesh(new T.CircleGeometry(0.033,20),MAT.tailOff,false,false);
  G.add(facePut(false,-0.545,0.360,0.005,fog));LIGHTS.tail.push(fog);
  var rev=mesh(new T.CircleGeometry(0.033,20),MAT.ledOff,false,false);
  G.add(facePut(false,0.545,0.360,0.005,rev));LIGHTS.rev.push(rev);

  /* ---- quad exhaust ---- */
  [-0.455,-0.310,0.310,0.455].forEach(function(x){
    var fr=faceFrame(false,x,0.492);
    var tip=new T.Group();
    var og=new T.CylinderGeometry(0.050,0.054,0.21,26,1,true);og.rotateX(PI/2);
    tip.add(mesh(og,MAT.chrome,true,false));
    var ig=new T.CylinderGeometry(0.042,0.044,0.20,22,1,true);ig.rotateX(PI/2);
    tip.add(mesh(ig,MAT.matte,false,false));
    var cp=mesh(new T.CircleGeometry(0.042,22),MAT.matte,false,false);
    cp.position.z=-0.095;cp.rotation.y=PI;tip.add(cp);
    tip.scale.set(1.22,0.84,1);
    var holder=new T.Group();holder.add(tip);
    orientTo(holder,fr.p.addScaledVector(fr.n,-0.075),fr.n);
    G.add(holder);
  });

  /* ---- plate, badge, script ---- */
  var pg=new T.BoxGeometry(0.42,0.115,0.014);
  G.add(facePut(false,0,0.520,0.012,new T.Mesh(pg,[MAT.trim,MAT.trim,MAT.trim,MAT.trim,MAT.plateR,MAT.trim])));
  var lg=new T.Mesh(new T.CircleGeometry(0.050,36),MAT.logo);
  G.add(facePut(false,0,0.762,0.007,lg));
  var mc=cvs(512,90),mx=mc.getContext('2d');
  mx.clearRect(0,0,512,90);mx.fillStyle='#cfd6e6';mx.font='bold 56px Arial';
  mx.textAlign='center';mx.textBaseline='middle';
  if('letterSpacing' in mx)mx.letterSpacing='12px';
  mx.fillText('GT-S',256,50);
  var mm=new T.MeshStandardMaterial({map:tex(mc,1,1),transparent:true,metalness:0.9,roughness:0.25});
  G.add(facePut(false,0.400,0.760,0.007,new T.Mesh(new T.PlaneGeometry(0.30,0.052),mm)));

  /* ---- ducktail lip ---- */
  var sp=new T.Shape();
  sp.moveTo(-0.815,0);sp.quadraticCurveTo(0,0.085,0.815,0);
  sp.lineTo(0.790,-0.105);sp.quadraticCurveTo(0,-0.030,-0.790,-0.105);sp.closePath();
  var spg=new T.ExtrudeGeometry(sp,{depth:0.030,bevelEnabled:true,bevelSize:0.009,bevelThickness:0.009,
    bevelSegments:2,curveSegments:22});
  spg.rotateX(-0.30);
  var lip=mesh(spg,MAT.paint,true,false);
  lip.position.set(0,0.862,-2.008);
  G.add(lip);
  return G;
}

/* ================= SIDES ================= */
function buildSides(onDoor){
  var G=new T.Group();
  [1,-1].forEach(function(sg){
    /* mirror and handle live on the door, so they swing with it */
    var D=onDoor?onDoor(sg):G;
    /* ---- mirror ---- */
    var mu=uAt(0.42),mv=vOuter(mu,0.745);
    if(sg<0)mv=1-mv;
    var f=frameAt(bodySurf,mu,mv);
    /* base blister: a raised patch of the skin itself, so nothing pierces the door */
    var bu0=mu-0.022,bu1=mu+0.022;
    var bv=function(y){var q=vOuter(uAt(0.42),y);return sg>0?q:1-q;};
    D.add(mesh(buildSurface(fadeOffsetFn(patchV(bodySurf,bu0,bu1,
      function(){return bv(0.688);},function(){return bv(0.818);}),0.046,0.32),30,28),MAT.gloss,true,false));
    var mg=new T.Group();
    /* sail panel: its root ring is sampled straight off the skin, so the mount
       is flush by construction - a rod or a tube always left a sliver of daylight */
    var podIn=f.p.clone().addScaledVector(f.n,0.014).add(new T.Vector3(sg*0.074,0.090,0));
    var sailFn=function(u,v){
      var a=v*PI*2;
      var uu=clamp(mu+0.023*Math.cos(a),0,1);
      var yy=0.760+0.060*Math.sin(a);
      var vv=vOuter(uu,yy);if(sg<0)vv=1-vv;
      var I=bodySurf(uu,vv).addScaledVector(f.n,-0.012);
      var O=podIn.clone();
      O.z-=0.030*Math.cos(a);O.y+=0.032*Math.sin(a);
      return I.lerp(O,u*u*(3-2*u));
    };
    D.add(mesh(buildSurface(sailFn,20,30,{closedV:true}),MAT.gloss,true,false));
    /* housing: painted shell over a dark under-tray */
    var hx=sg*0.202,hy=0.090;
    var hous=mesh(roundedBox(0.178,0.080,0.130,0.038,14),MAT.paint,true,false);
    hous.position.set(hx,hy+0.015,0.0);hous.rotation.set(0.07,0,sg*0.06);
    mg.add(hous);
    var tray=mesh(roundedBox(0.172,0.052,0.126,0.030,12),MAT.matte,false,false);
    tray.position.set(hx,hy-0.026,0.002);tray.rotation.set(0.07,0,sg*0.06);
    mg.add(tray);
    /* mirror glass, recessed into the rear face */
    var back=mesh(roundedBox(0.146,0.074,0.020,0.014,8),MAT.matte,false,false);
    back.position.set(hx,hy+0.008,-0.060);back.rotation.set(0.07,0,sg*0.06);
    mg.add(back);
    var gl=mesh(new T.PlaneGeometry(0.134,0.064),new T.MeshPhysicalMaterial(
      {color:0xa8bcd6,metalness:1,roughness:0.045,envMap:MAT.chrome.envMap,envMapIntensity:1.9}),false,false);
    gl.position.set(hx,hy+0.008,-0.069);gl.rotation.set(0.07,PI,sg*0.06);
    mg.add(gl);
    /* indicator sunk into the outboard edge of the shell */
    var ind=mesh(roundedBox(0.106,0.013,0.015,0.006,8),MAT.amber,false,false);
    ind.position.set(hx+sg*0.008,hy-0.002,0.054);ind.rotation.set(0.07,0,sg*0.06);
    mg.add(ind);
    mg.position.copy(f.p).addScaledVector(f.n,0.014);
    D.add(mg);

    /* ---- door handle: flush pull, sunk in its own pocket ---- */
    var ch=CUT.handle[sg>0?0:1];
    D.add(mesh(buildSurface(bodyReliefFn(bodyRect(ch),0.002),22,12),MAT.matte,false,false));
    var hf=frameAt(bodySurf,(ch.u0+ch.u1)/2,(ch.v0+ch.v1)/2);
    var hb=mesh(roundedBox(0.185,0.021,0.016,0.008,8),MAT.satin,false,false);
    orientTo(hb,hf.p.addScaledVector(hf.n,-0.008),hf.n);
    D.add(hb);

    /* ---- side intake behind the door: a gill with fins ---- */
    var cv=CUT.vent[sg>0?0:1];
    G.add(mesh(buildSurface(bodyReliefFn(bodyRect(cv),0.004),34,16),MAT.mesh,false,false));
    [0.30,0.52,0.74].forEach(function(t){
      var vv=lerp(cv.v0,cv.v1,t);
      var pts=[],k;
      for(k=0;k<=8;k++){
        var uu=lerp(cv.u0+0.006,cv.u1-0.006,k/8);
        var fr=frameAt(bodySurf,uu,vv);
        pts.push(fr.p.addScaledVector(fr.n,-0.030));
      }
      var fin=mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts),20,0.0075,8,false),MAT.satin,false,false);
      G.add(fin);
    });
    /* body-coloured leading lip so the gill reads as a scoop */
    var lipF=function(u,v){
      var U=lerp(cv.u1-0.010,cv.u1+0.004,u),V=lerp(cv.v0,cv.v1,v);
      var fr=frameAt(bodySurf,U,V);
      return fr.p.addScaledVector(fr.n,-0.006-0.030*(1-u));
    };
    G.add(mesh(buildSurface(lipF,10,16),MAT.paint,false,false));

    /* ---- side marker ---- */
    var ku=uAt(1.72),kv=vOuter(ku,0.585);
    if(sg<0)kv=1-kv;
    var km=mesh(new T.CircleGeometry(0.022,16),MAT.amber,false,false);
    G.add(putOn(bodySurf,ku,kv,0.004,km));
  });

  /* fuel filler (left rear quarter) */
  var cf=CUT.fuel;
  G.add(mesh(buildSurface(bodyReliefFn(bodyRect(cf),0.001),12,12),MAT.trim,false,false));
  var ff=frameAt(bodySurf,(cf.u0+cf.u1)/2,(cf.v0+cf.v1)/2);
  var fc=mesh(new T.CircleGeometry(0.052,26),MAT.satin,false,false);
  orientTo(fc,ff.p.addScaledVector(ff.n,-0.006),ff.n);
  G.add(fc);
  return G;
}

/* ================= INTERIOR ================= */
function buildSeat(){
  var S=new T.Group();
  var base=mesh(roundedBox(0.46,0.14,0.50,0.055,10),MAT.leather,false,false);
  base.position.set(0,0.07,0.03);S.add(base);
  [1,-1].forEach(function(sg){
    var bol=mesh(roundedBox(0.09,0.12,0.44,0.045,8),MAT.leather,false,false);
    bol.position.set(sg*0.195,0.105,0.02);S.add(bol);
    var bb=mesh(roundedBox(0.085,0.47,0.12,0.042,8),MAT.leather,false,false);
    bb.position.set(sg*0.185,0.41,-0.175);bb.rotation.x=0.16;S.add(bb);
  });
  var back=mesh(roundedBox(0.42,0.54,0.13,0.05,10),MAT.alcantara,false,false);
  back.position.set(0,0.41,-0.20);back.rotation.x=0.16;S.add(back);
  var neck=mesh(roundedBox(0.20,0.12,0.11,0.04,8),MAT.leather,false,false);
  neck.position.set(0,0.672,-0.275);S.add(neck);
  var head=mesh(roundedBox(0.26,0.185,0.125,0.055,10),MAT.alcantara,false,false);
  head.position.set(0,0.775,-0.300);head.rotation.x=0.10;S.add(head);
  /* harness slots */
  [1,-1].forEach(function(sg){
    var sl=mesh(roundedBox(0.055,0.070,0.05,0.02,6),MAT.matte,false,false);
    sl.position.set(sg*0.10,0.640,-0.255);S.add(sl);
  });
  /* belt */
  var bg=new T.PlaneGeometry(0.055,0.72);
  var belt=mesh(bg,new T.MeshStandardMaterial({color:0x161a20,roughness:0.85,side:T.DoubleSide}),false,false);
  belt.position.set(0.14,0.40,-0.125);belt.rotation.set(0.16,0.22,0.22);S.add(belt);
  /* stitch line */
  var st=mesh(new T.BoxGeometry(0.006,0.55,0.006),MAT.stitch,false,false);
  st.position.set(0,0.41,-0.142);st.rotation.x=0.16;S.add(st);
  return S;
}
function buildInterior(){
  var G=new T.Group(),PARTS={};
  /* seats (driver on the left = +X) */
  [1,-1].forEach(function(sg){
    var s=buildSeat();
    s.position.set(sg*0.335,0.437,-0.34);
    G.add(s);
  });
  /* dashboard */
  var dash=mesh(roundedBox(1.28,0.26,0.30,0.07,12),MAT.alcantara,false,false);
  dash.position.set(0,0.80,0.38);dash.rotation.x=-0.22;G.add(dash);
  var dtop=mesh(roundedBox(1.30,0.05,0.34,0.024,10),MAT.matte,false,false);
  dtop.position.set(0,0.905,0.36);dtop.rotation.x=-0.20;G.add(dtop);
  /* cluster + centre screen */
  var cl=new T.Mesh(new T.PlaneGeometry(0.34,0.17),MAT.screen);
  cl.position.set(0.335,0.862,0.208);cl.rotation.x=-0.26;
  cl.renderOrder=2;G.add(cl);PARTS.cluster=cl;
  var cs=new T.Mesh(new T.PlaneGeometry(0.26,0.15),MAT.screen);
  cs.position.set(0,0.818,0.206);cs.rotation.set(-0.22,0,0);G.add(cs);PARTS.centre=cs;
  var csf=mesh(roundedBox(0.30,0.19,0.03,0.012,8),MAT.gloss,false,false);
  csf.position.set(0,0.816,0.220);csf.rotation.x=-0.22;G.add(csf);
  /* air vents */
  [-0.50,-0.16,0.16,0.50].forEach(function(x){
    var v=mesh(roundedBox(0.17,0.055,0.05,0.018,8),MAT.matte,false,false);
    v.position.set(x,0.752,0.232);G.add(v);
    var f=mesh(new T.BoxGeometry(0.15,0.006,0.03),MAT.gloss,false,false);
    f.position.set(x,0.752,0.212);G.add(f);
  });
  /* steering wheel */
  var W=new T.Group();
  var rim=mesh(new T.TorusGeometry(0.155,0.0225,14,44),MAT.leather,false,false);
  W.add(rim);
  var flat=mesh(roundedBox(0.20,0.030,0.045,0.014,8),MAT.leather,false,false);
  flat.position.set(0,-0.146,0);W.add(flat);
  var hub=mesh(new T.CylinderGeometry(0.055,0.048,0.055,22),MAT.matte,false,false);
  hub.rotation.x=PI/2;W.add(hub);
  var lg=new T.Mesh(new T.CircleGeometry(0.030,26),MAT.logo);
  lg.position.z=0.030;W.add(lg);
  [0.34,PI-0.34,-PI/2].forEach(function(a){
    var sp=mesh(roundedBox(0.115,0.032,0.028,0.012,8),MAT.satin,false,false);
    sp.position.set(Math.cos(a)*0.095,Math.sin(a)*0.095,0.006);
    sp.rotation.z=a;W.add(sp);
  });
  [1,-1].forEach(function(sg){
    var pd=mesh(roundedBox(0.028,0.085,0.012,0.005,6),MAT.satin,false,false);
    pd.position.set(sg*0.11,0.055,-0.048);W.add(pd);
  });
  W.position.set(0.335,0.855,0.10);W.rotation.x=0.35;
  G.add(W);PARTS.wheel=W;
  var col=mesh(new T.CylinderGeometry(0.035,0.045,0.24,16),MAT.matte,false,false);
  col.position.set(0.335,0.815,0.20);col.rotation.set(PI/2-0.35,0,0);G.add(col);
  /* centre console + shifter */
  var con=mesh(roundedBox(0.24,0.26,0.98,0.05,10),MAT.leather,false,false);
  con.position.set(0,0.545,-0.24);G.add(con);
  var ct=mesh(roundedBox(0.20,0.03,0.62,0.014,8),MAT.carbon,false,false);
  ct.position.set(0,0.678,-0.12);G.add(ct);
  var lev=mesh(new T.CylinderGeometry(0.014,0.020,0.13,12),MAT.satin,false,false);
  lev.position.set(0,0.735,0.02);G.add(lev);
  var knob=mesh(roundedBox(0.055,0.075,0.055,0.026,10),MAT.leather,false,false);
  knob.position.set(0,0.805,0.02);G.add(knob);PARTS.shift=knob;
  [[-0.06,-0.22],[0.06,-0.22],[-0.06,-0.31],[0.06,-0.31]].forEach(function(q){
    var bt=mesh(roundedBox(0.045,0.012,0.045,0.006,6),MAT.gloss,false,false);
    bt.position.set(q[0],0.688,q[1]);G.add(bt);
  });
  var sb=mesh(new T.CylinderGeometry(0.026,0.026,0.016,20),MAT.caliper,false,false);
  sb.position.set(0,0.690,0.06);G.add(sb);
  /* roll hoops */
  [1,-1].forEach(function(sg){
    var hp=[new T.Vector3(sg*0.16,0.90,-0.90),new T.Vector3(sg*0.335,1.075,-0.90),
            new T.Vector3(sg*0.50,0.90,-0.90)];
    G.add(mesh(new T.TubeGeometry(new T.CatmullRomCurve3(hp),18,0.030,10,false),MAT.satin,false,false));
  });
  /* rear bulkhead panel */
  var bh=mesh(roundedBox(1.15,0.36,0.06,0.03,8),MAT.alcantara,false,false);
  bh.position.set(0,0.72,-0.99);bh.rotation.x=-0.12;G.add(bh);
  /* pedals + footwell */
  [[0.255,0.05],[0.395,0.02],[0.135,0.06]].forEach(function(q,i){
    if(i>1)return;
    var pd=mesh(roundedBox(0.075,0.16,0.016,0.008,6),MAT.satin,false,false);
    pd.position.set(q[0],0.50+q[1],0.60);pd.rotation.x=-0.34;G.add(pd);
    PARTS[i?'brake':'gas']=pd;
  });
  /* interior mirror, hung off the windscreen header */
  var mg=new T.Group();
  var mstem=mesh(roundedBox(0.030,0.052,0.028,0.010,8),MAT.matte,false,false);
  mstem.position.set(0,0.040,0.020);mg.add(mstem);
  var mbody=mesh(roundedBox(0.255,0.062,0.032,0.015,10),MAT.matte,false,false);
  mg.add(mbody);
  var mglass=new T.Mesh(new T.PlaneGeometry(0.232,0.050),new T.MeshPhysicalMaterial(
    {color:0x93a6c2,metalness:1,roughness:0.06,envMap:MAT.chrome.envMap,envMapIntensity:1.6}));
  mglass.position.z=0.018;mg.add(mglass);
  mg.position.set(0,1.232,0.330);mg.rotation.x=0.12;
  G.add(mg);
  /* door cards: speakers */
  [1,-1].forEach(function(sg){
    var sp=mesh(new T.CylinderGeometry(0.075,0.075,0.02,24),MAT.matte,false,false);
    sp.rotation.z=PI/2;sp.position.set(sg*0.618,0.60,0.10);G.add(sp);
    var ar=mesh(roundedBox(0.07,0.06,0.42,0.025,8),MAT.leather,false,false);
    ar.position.set(sg*0.600,0.740,-0.22);G.add(ar);
  });
  /* the driving page animates these: wheel, pedals, live screens */
  G.userData.parts=PARTS;
  return G;
}

/* ---- studio environment (procedural, no external HDRI) ---- */
function studioEnv(){
  var s=new T.Scene();
  function panel(w,h,pos,rot,col,int){
    var m=new T.MeshBasicMaterial({color:new T.Color(col[0]*int,col[1]*int,col[2]*int),side:T.DoubleSide});
    var p=new T.Mesh(new T.PlaneGeometry(w,h),m);
    p.position.set(pos[0],pos[1],pos[2]);p.rotation.set(rot[0],rot[1],rot[2]);
    s.add(p);return p;
  }
  var room=new T.Mesh(new T.BoxGeometry(34,20,34),
    new T.MeshBasicMaterial({color:new T.Color(0.035,0.040,0.052),side:T.BackSide}));
  s.add(room);
  panel(30,30,[0,-5.6,0],[-PI/2,0,0],[0.085,0.092,0.110],1);    /* floor bounce */
  panel(15,11,[0,8.4,0],[PI/2,0,0],[1,1,1],2.45);               /* main softbox */
  panel(17,7.0,[-8.6,3.4,0],[0,PI/2,0],[0.66,0.76,1.0],1.15);   /* cool wall */
  panel(17,6.0,[8.6,3.0,0],[0,-PI/2,0],[1.0,0.88,0.74],0.80);   /* warm wall */
  panel(15,2.4,[-8.2,5.4,0],[0,PI/2,0],[0.72,0.82,1.0],2.60);   /* cool strip */
  panel(15,1.8,[8.2,5.0,0],[0,-PI/2,0],[1.0,0.84,0.66],1.90);   /* warm strip */
  panel(16,2.2,[0,3.8,-9.5],[0,0,0],[0.74,0.84,1.0],2.30);      /* rim */
  panel(13,2.6,[0,2.6,9.5],[0,PI,0],[0.86,0.90,1.0],1.05);      /* front fill */
  return s;
}

/* ================= PEOPLE =================
   One procedural figure, built at two levels of detail: `low` for the
   instanced crowd in town, `high` for the driver you actually look at.
   Limbs are posed by two-bone IK rather than by hand-tuned joint angles,
   so the hands land exactly on the rim and the feet exactly on the
   pedals - and keep landing there when the wheel turns or he walks. */
var DOWN=new T.Vector3(0,-1,0),_ik=[new T.Vector3(),new T.Vector3(),new T.Vector3(),new T.Vector3()];
var _bx=new T.Vector3(),_by=new T.Vector3(),_bz=new T.Vector3(),_bm=new T.Matrix4();
function bone(len,r0,r1,mat){
  var g=new T.Group();
  var m=mesh(new T.CylinderGeometry(r1,r0,len,10,1),mat,true,false);
  m.position.y=-len/2;g.add(m);
  g.add(mesh(new T.SphereGeometry(r0,10,8),mat,true,false));
  g.userData.len=len;
  return g;
}
/* -Y down the bone, and the pole decides the roll as well as the bend, so
   an elbow, a knee and the hand hanging off it all face somewhere sensible */
function aimBone(obj,dir,pole){
  _by.copy(dir).multiplyScalar(-1);
  _bz.copy(pole).addScaledVector(dir,-pole.dot(dir));
  if(_bz.lengthSq()<1e-8)_bz.set(-dir.y,dir.x,0);
  _bz.normalize().multiplyScalar(-1);
  _bx.crossVectors(_by,_bz);
  _bm.makeBasis(_bx,_by,_bz);
  obj.quaternion.setFromRotationMatrix(_bm);
}
/* S -> Tt with two bones of length a,b; the joint bends towards pole */
function poseChain(up,fore,end,S,Tt,pole){
  var a=up.userData.len,b=fore.userData.len;
  var d=_ik[0].subVectors(Tt,S),len=d.length();
  var mx=a+b-0.006,mn=Math.abs(a-b)+0.03;
  if(len>mx){d.multiplyScalar(mx/len);len=mx;}
  else if(len<mn){d.multiplyScalar(mn/Math.max(len,1e-5));len=mn;}
  var u=_ik[1].copy(d).normalize();
  var p=_ik[2].copy(pole).addScaledVector(u,-pole.dot(u));
  if(p.lengthSq()<1e-7)p.set(-u.y,u.x,0);
  p.normalize();
  var ca=clamp((a*a+len*len-b*b)/(2*a*len),-1,1),al=Math.acos(ca);
  var d1=_ik[3].copy(u).multiplyScalar(Math.cos(al)).addScaledVector(p,Math.sin(al));
  up.position.copy(S);aimBone(up,d1,p);
  var ex=S.x+d1.x*a,ey=S.y+d1.y*a,ez=S.z+d1.z*a;
  var tx=S.x+d.x,ty=S.y+d.y,tz=S.z+d.z;
  fore.position.set(ex,ey,ez);
  d1.set(tx-ex,ty-ey,tz-ez).normalize();
  aimBone(fore,d1,p);
  if(end){end.position.set(tx,ty,tz);end.quaternion.copy(fore.quaternion);}
}

/* ---- the head, the part that decides whether he reads as a person ---- */
/* the face is painted, not modelled: at this size a geometric eye is a
   blob, while a decal on a patch of the skull reads instantly */
var _faceT=null;
function faceTexture(){
  if(_faceT)return _faceT;
  var c=cvs(512,512),x=c.getContext('2d');
  x.clearRect(0,0,512,512);
  function eye(cx,cy,s){
    x.save();x.translate(cx,cy);x.scale(s*1.18,1.18);
    x.fillStyle='#eef1f6';
    x.beginPath();x.moveTo(-46,0);
    x.quadraticCurveTo(0,-32,46,-2);
    x.quadraticCurveTo(0,27,-46,0);x.closePath();x.fill();
    x.fillStyle='#3c2a1d';x.beginPath();x.arc(3,-2,18,0,PI*2);x.fill();
    x.fillStyle='#120c07';x.beginPath();x.arc(3,-2,8.2,0,PI*2);x.fill();
    x.fillStyle='#ffffff';x.beginPath();x.arc(-4,-9,5,0,PI*2);x.fill();
    /* upper lid gives the eye a top edge instead of a floating oval */
    x.strokeStyle='#6b4a35';x.lineWidth=7.5;x.lineCap='round';
    x.beginPath();x.moveTo(-46,-1);x.quadraticCurveTo(0,-33,46,-3);x.stroke();
    x.restore();
  }
  eye(166,256,1);eye(346,256,-1);
  x.fillStyle='#241c16';
  [[166,1],[346,-1]].forEach(function(b){
    x.save();x.translate(b[0],220);x.scale(b[1]*1.1,1);
    x.beginPath();x.moveTo(-52,9);x.quadraticCurveTo(-4,-15,50,1);
    x.quadraticCurveTo(-2,3,-50,23);x.closePath();x.fill();x.restore();
  });
  /* mouth: a shadowed line with a lit lower lip under it */
  x.strokeStyle='#7d4a41';x.lineWidth=9;x.lineCap='round';
  x.beginPath();x.moveTo(214,373);x.quadraticCurveTo(256,385,298,373);x.stroke();
  x.strokeStyle='rgba(214,142,128,.55)';x.lineWidth=13;
  x.beginPath();x.moveTo(218,387);x.quadraticCurveTo(256,396,294,387);x.stroke();
  _faceT=tex(c,1,1);
  return _faceT;
}
function buildHead(P,skin,hi,o){
  var head=new T.Group();
  var neck=mesh(new T.CylinderGeometry(0.050,0.063,0.100,hi?12:10),skin,true,false);
  neck.position.y=0.020;head.add(neck);
  var skull=mesh(new T.SphereGeometry(0.108,hi?22:16,hi?18:14),skin,true,false);
  skull.scale.set(0.92,1.10,1.00);skull.position.y=0.150;head.add(skull);
  if(hi){
    /* jaw and chin, so the skull is not just a ball */
    var jaw=mesh(roundedBox(0.132,0.112,0.140,0.055,10),skin,false,false);
    jaw.position.set(0,0.092,0.012);jaw.rotation.x=-0.04;head.add(jaw);
    var chin=mesh(new T.SphereGeometry(0.026,12,10),skin,false,false);
    chin.scale.set(1.30,0.80,0.90);chin.position.set(0,0.068,0.052);head.add(chin);
    var nose=mesh(new T.SphereGeometry(0.0155,12,10),skin,false,false);
    nose.scale.set(1.0,1.15,1.30);nose.position.set(0,0.146,0.094);head.add(nose);
    var fm=new T.MeshStandardMaterial({map:faceTexture(),transparent:true,
      roughness:0.72,metalness:0,color:0xffffff,depthWrite:false,polygonOffset:true,
      polygonOffsetFactor:-2,polygonOffsetUnits:-2});
    fm.envMap=skin.envMap;fm.envMapIntensity=0.15;
    var face=new T.Mesh(new T.SphereGeometry(0.1086,26,22,PI/2-0.66,1.32,0.95,1.10),fm);
    face.scale.set(0.92,1.10,1.00);face.position.y=0.150;
    face.renderOrder=1;head.add(face);
  }
  var ear=mesh(new T.SphereGeometry(0.029,hi?10:8,hi?8:6),skin,false,false);
  ear.scale.set(0.40,1,0.76);ear.position.set(0.097,0.144,-0.006);head.add(ear);
  var ear2=ear.clone();ear2.position.x=-0.097;head.add(ear2);
  /* hair: a cap of the same ellipsoid, tipped back so the hairline sits right */
  var hair=mesh(new T.SphereGeometry(0.118,hi?22:16,hi?16:12,0,PI*2,0,1.60),MAT.hair,true,false);
  hair.scale.set(0.960,1.060,1.030);hair.position.set(0,0.168,-0.015);
  hair.rotation.x=-0.50;head.add(hair);
  var nape=mesh(roundedBox(0.164,0.110,0.092,0.046,hi?8:6),MAT.hair,true,false);
  nape.position.set(0,0.122,-0.080);head.add(nape);
  if(o.shades){
    var sh=mesh(roundedBox(0.176,0.048,0.056,0.017,7),MAT.shades,false,false);
    sh.position.set(0,0.168,0.082);head.add(sh);
    if(hi){
      var tm=mesh(roundedBox(0.011,0.009,0.108,0.004,5),MAT.shades,false,false);
      tm.position.set(0.085,0.170,0.034);head.add(tm);
      var tm2=tm.clone();tm2.position.x=-0.085;head.add(tm2);
    }
  }
  P.head=head;
  return head;
}

/* origin sits at the hip joint; +Z is the way the figure faces */
function buildPerson(o){
  o=o||{};
  var hi=(o.detail==='high');
  var G=new T.Group(),P={g:G,hi:hi};
  var skin=o.skin||MAT.skin,shirt=o.shirt||MAT.shirt,leg=o.trouser||MAT.trouser;
  var coat=o.jacket||shirt;
  var lean=(o.lean===undefined)?-0.16:o.lean;
  if(o.shades===undefined)o.shades=!hi;
  var pelvis=mesh(roundedBox(0.272,0.186,0.214,0.078,hi?9:7),leg,true,false);
  pelvis.position.y=-0.018;G.add(pelvis);P.pelvis=pelvis;
  var body=new T.Group();body.rotation.x=lean;G.add(body);P.body=body;
  /* torso: chest, waist, yoke and collar rather than one slab. Every panel
     carries the tint flag, so an instanced crowd gets one colour per person
     instead of a coloured patch on a white shirt. */
  var chest=mesh(roundedBox(0.306,0.312,0.204,0.096,hi?10:8),coat,true,false);
  chest.position.y=0.322;body.add(chest);
  var waist=mesh(roundedBox(0.248,0.205,0.180,0.078,hi?9:7),coat,true,false);
  waist.position.y=0.128;body.add(waist);
  var collar=mesh(roundedBox(0.182,0.086,0.176,0.056,hi?8:6),coat,true,false);
  collar.position.y=0.470;body.add(collar);
  var yoke=mesh(roundedBox(0.348,0.126,0.196,0.060,hi?9:7),coat,true,false);
  yoke.position.y=0.416;body.add(yoke);
  [chest,waist,collar,yoke].forEach(function(m){m.userData.tint=true;});
  if(hi){
    /* a tee showing through an open jacket, with the zip either side of it */
    var tee=mesh(roundedBox(0.092,0.290,0.196,0.042,9),MAT.tee,false,false);
    tee.position.set(0,0.314,0.008);body.add(tee);
    [1,-1].forEach(function(s){
      var z=mesh(roundedBox(0.048,0.372,0.196,0.044,8),coat,false,false);
      z.position.set(s*0.100,0.302,0.008);z.rotation.z=-s*0.04;body.add(z);
      var lap=mesh(roundedBox(0.044,0.112,0.032,0.013,7),coat,false,false);
      lap.position.set(s*0.062,0.440,0.076);lap.rotation.set(0.16,0,-s*0.26);body.add(lap);
    });
    var pk=mesh(roundedBox(0.058,0.050,0.014,0.007,6),MAT.trim,false,false);
    pk.position.set(-0.098,0.356,0.100);body.add(pk);
    var hem=mesh(roundedBox(0.262,0.044,0.190,0.020,8),MAT.trim,false,false);
    hem.position.y=0.024;body.add(hem);
    var belt=mesh(roundedBox(0.278,0.046,0.222,0.020,8),MAT.belt,false,false);
    belt.position.y=0.058;G.add(belt);
    var bkl=mesh(roundedBox(0.046,0.036,0.016,0.006,6),MAT.satin,false,false);
    bkl.position.set(0,0.058,0.114);G.add(bkl);
  }
  body.add(buildHead(P,skin,hi,o));
  P.head.position.set(0,0.512,0.008);
  /* arms and legs live in the figure's own space so IK can drive them flat */
  P.shL=new T.Vector3( 0.163,0.455,0.012);
  P.shR=new T.Vector3(-0.163,0.455,0.012);
  P.body.updateMatrix();
  P.shL.applyMatrix4(P.body.matrix);P.shR.applyMatrix4(P.body.matrix);
  P.hipL=new T.Vector3( 0.095,-0.02,0.01);
  P.hipR=new T.Vector3(-0.095,-0.02,0.01);
  function hand(s){
    var h=new T.Group(),k=new T.Group();
    k.rotation.set(0.10,0,0);h.add(k);
    if(hi){
      var cuff=mesh(roundedBox(0.078,0.036,0.070,0.016,7),coat,false,false);
      cuff.position.y=0.006;k.add(cuff);
      var palm=mesh(roundedBox(0.070,0.092,0.050,0.020,8),skin,true,false);
      palm.position.set(0,-0.048,0.002);k.add(palm);
      /* one curled roll of fingers reads as a grip on the rim and as a
         relaxed fist when he walks - and it survives any wrist roll */
      var fing=mesh(roundedBox(0.066,0.062,0.062,0.026,8),skin,true,false);
      fing.position.set(0,-0.104,0.020);fing.rotation.x=-0.22;k.add(fing);
      var thumb=mesh(roundedBox(0.030,0.064,0.032,0.014,7),skin,false,false);
      thumb.position.set(-s*0.036,-0.076,0.030);thumb.rotation.set(-0.5,0,s*0.42);k.add(thumb);
      if(s>0){
        var w=mesh(new T.CylinderGeometry(0.026,0.026,0.013,14),MAT.satin,false,false);
        w.rotation.z=PI/2;w.position.set(0,0.002,-0.020);k.add(w);
      }
    }else{
      var hm=mesh(roundedBox(0.075,0.115,0.055,0.026,6),skin,true,false);
      hm.position.y=-0.035;k.add(hm);
    }
    return h;
  }
  function foot(){
    var f=new T.Group(),k=new T.Group();f.add(k);
    if(hi){
      var sole=mesh(roundedBox(0.108,0.030,0.272,0.014,7),MAT.sole,true,false);
      sole.position.set(0,-0.062,0.074);k.add(sole);
      var up=mesh(roundedBox(0.098,0.070,0.230,0.030,8),MAT.shoe,true,false);
      up.position.set(0,-0.032,0.058);k.add(up);
      var toe=mesh(roundedBox(0.090,0.052,0.086,0.026,8),MAT.shoe,false,false);
      toe.position.set(0,-0.040,0.152);k.add(toe);
      var lace=mesh(roundedBox(0.046,0.014,0.110,0.006,6),MAT.tee,false,false);
      lace.position.set(0,-0.006,0.062);lace.rotation.x=0.14;k.add(lace);
      var heel=mesh(roundedBox(0.096,0.060,0.056,0.022,7),MAT.shoe,false,false);
      heel.position.set(0,-0.030,-0.036);k.add(heel);
    }else{
      var fm=mesh(roundedBox(0.105,0.075,0.265,0.032,6),MAT.shoe,true,false);
      fm.position.set(0,-0.038,0.075);k.add(fm);
    }
    return f;
  }
  function arm(s){
    var up=bone(0.285,0.056,0.044,coat),fore=bone(0.255,0.044,0.036,hi?MAT.sleeve:skin);
    var h=hand(s);
    /* the sleeve is part of the garment: it must take the crowd tint too,
       and three.js draws an untinted instance of a tinted material black */
    up.children.forEach(function(m){m.userData.tint=true;});
    G.add(up);G.add(fore);G.add(h);
    return {up:up,fore:fore,hand:h};
  }
  function limb(){
    var up=bone(0.455,0.084,0.066,leg),fore=bone(0.440,0.064,0.052,leg);
    var f=foot();
    G.add(up);G.add(fore);G.add(f);
    return {up:up,fore:fore,hand:f};
  }
  P.armL=arm(1);P.armR=arm(-1);P.legL=limb();P.legR=limb();
  P.hipY=0.905;                       /* hip height when he stands upright */
  /* a default standing pose, so a figure is usable with no posing at all */
  var pl=new T.Vector3(0,0,1);
  poseChain(P.legL.up,P.legL.fore,P.legL.hand,P.hipL,
            new T.Vector3(0.10,-0.86,0.02),pl);
  poseChain(P.legR.up,P.legR.fore,P.legR.hand,P.hipR,
            new T.Vector3(-0.10,-0.86,0.02),pl);
  var pa=new T.Vector3(0,0,-1);
  poseChain(P.armL.up,P.armL.fore,P.armL.hand,P.shL,
            new T.Vector3(0.215,-0.10,0.03),pa);
  poseChain(P.armR.up,P.armR.fore,P.armR.hand,P.shR,
            new T.Vector3(-0.215,-0.10,0.03),pa);
  return P;
}
/* ================= ASSEMBLE THE CAR ================= */
function buildCar(o){
  LOD=(o&&o.lod)||1;
  var car=new T.Group(),wheels=[],steerables=[];
  initCuts();
  car.add(buildBody());
  car.add(buildGreenhouse());
  car.add(buildFront());
  car.add(buildRear());
  var doors={};
  [1,-1].forEach(function(sg){
    var d=buildDoor(sg);
    doors[sg>0?'L':'R']=d;      /* the driver sits on the left = +X */
    car.add(d);
  });
  car.add(buildSides(function(sg){return doors[sg>0?'L':'R'].userData.skin;}));
  var interior=buildInterior();
  car.add(interior);
  [[CAR.axF,CAR.trF,true],[CAR.axR,CAR.trR,false]].forEach(function(ax){
    [1,-1].forEach(function(sg){
      var w=buildWheel(ax[2]);
      w.position.set(sg*ax[1],ax[2]?CAR.rF:CAR.rR,ax[0]);
      if(sg<0)w.scale.x=-1;
      car.add(w);
      wheels.push({g:w,spin:w.children[0],r:ax[2]?CAR.rF:CAR.rR});
      if(ax[2])steerables.push(w);
    });
  });
  return {car:car,wheels:wheels,steerables:steerables,doors:doors,
          interior:interior.userData.parts};
}


return {
  CAR:CAR, LIGHTS:LIGHTS, MAT:MAT,
  makeMaterials:makeMaterials, studioEnv:studioEnv, build:buildCar, DOOR:DOOR,
  person:buildPerson, poseChain:poseChain,
  util:{cvs:cvs,tex:tex,blobTexture:blobTexture,mesh:mesh,roundedBox:roundedBox,
        revolveX:revolveX,buildSurface:buildSurface,curve1D:curve1D,
        smoothstep:smoothstep,smax:smax,carbonTexture:carbonTexture,logoTexture:logoTexture},
  surf:{bodySurf:bodySurf,ghSurf:ghSurf,ghVf:ghVf,vOuter:vOuter,frameAt:frameAt,uAt:uAt,zAt:zAt,
        topLine:topLine,sillY:sillY,halfW:halfW}
};
})();
