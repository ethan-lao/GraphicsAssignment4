import { ToneMapping } from "../lib/threejs/src/constants.js";
import { Mat4, Quat, Vec3, Vec4, Mat3 } from "../lib/TSM.js";
import { AttributeLoader, MeshGeometryLoader, BoneLoader, MeshLoader } from "./AnimationFileLoader.js";

export class Attribute {
  values: Float32Array;
  count: number;
  itemSize: number;

  constructor(attr: AttributeLoader) {
    this.values = attr.values;
    this.count = attr.count;
    this.itemSize = attr.itemSize;
  }
}

export class MeshGeometry {
  position: Attribute;
  normal: Attribute;
  uv: Attribute | null;
  skinIndex: Attribute; // which bones affect each vertex?
  skinWeight: Attribute; // with what weight?
  v0: Attribute; // position of each vertex of the mesh *in the coordinate system of bone skinIndex[0]'s joint*. Perhaps useful for LBS.
  v1: Attribute;
  v2: Attribute;
  v3: Attribute;

  constructor(mesh: MeshGeometryLoader) {
    this.position = new Attribute(mesh.position);
    this.normal = new Attribute(mesh.normal);
    if (mesh.uv) { this.uv = new Attribute(mesh.uv); }
    this.skinIndex = new Attribute(mesh.skinIndex);
    this.skinWeight = new Attribute(mesh.skinWeight);
    this.v0 = new Attribute(mesh.v0);
    this.v1 = new Attribute(mesh.v1);
    this.v2 = new Attribute(mesh.v2);
    this.v3 = new Attribute(mesh.v3);
  }
}

export class Bone {
  public parent: number;
  public children: number[];
  public position: Vec3; // current position of the bone's joint *in world coordinates*. Used by the provided skeleton shader, so you need to keep this up to date.
  public endpoint: Vec3; // current position of the bone's second (non-joint) endpoint, in world coordinates
  public rotation: Quat; // current orientation of the joint *with respect to world coordinates*
  
  public initialPosition: Vec3; // position of the bone's joint *in world coordinates*
  public initialEndpoint: Vec3; // position of the bone's second (non-joint) endpoint, in world coordinates

  public offset: number; // used when parsing the Collada file---you probably don't need to touch these
  public initialTransformation: Mat4;

  static readonly RAY_EPSILON: number = .0001;
  static readonly CYL_RADIUS: number = .1;

  public localRot;
  public transB;

  constructor(bone: BoneLoader) {
    this.parent = bone.parent;
    this.children = Array.from(bone.children);
    this.position = bone.position.copy();
    this.endpoint = bone.endpoint.copy();
    this.rotation = bone.rotation.copy();
    this.offset = bone.offset;
    this.initialPosition = bone.initialPosition.copy();
    this.initialEndpoint = bone.initialEndpoint.copy();
    this.initialTransformation = bone.initialTransformation.copy();

    this.localRot = bone.rotation.copy();
    this.transB = Mat4.identity.copy();
  }

  public intersect(pos: Vec3, dir: Vec3): number {
    let start = this.position;
    let end = this.endpoint;
    let boneDir = Vec3.difference(end, start).normalize();

    // https://www.geeksforgeeks.org/shortest-distance-between-two-lines-in-3d-space-class-12-maths/
    
    // get distance
    let cross = Vec3.cross(dir, boneDir);
    let ptDiff = Vec3.difference(start, pos);
    let distance = Math.abs(Vec3.dot(ptDiff, cross.normalize()));

    if (distance > Bone.CYL_RADIUS) {
      return -1;
    }

    // https://math.stackexchange.com/questions/1359446/how-to-find-the-points-of-intersection-of-the-perpendicular-vector-two-skew-line
    
    // point on cylinder
    let q2 = Vec3.sum(start, 
      boneDir.scale(
        Vec3.dot(ptDiff, Vec3.cross(dir, cross)) / 
        Vec3.dot(cross, cross)
      ));

    // check if within endpoints of cylinder
    let cylinderLength = Vec3.difference(end, start).length();
    if (Vec3.difference(end, q2).length() > cylinderLength ||
      Vec3.difference(start, q2).length() > cylinderLength) {
        return -1;
    }

    // point on our ray
    let q1 = Vec3.sum(start, 
      boneDir.scale(
        Vec3.dot(ptDiff, Vec3.cross(dir, cross)) / 
        Vec3.dot(cross, cross)
      ));

    // check if behind us
    if (Vec3.difference(q1, Vec3.sum(pos, dir.scale(Bone.RAY_EPSILON))).length() >
      Vec3.difference(q1, pos).length()) {
      return -1;
    }

    return Math.abs(Vec3.difference(q1, pos).length());
  }

  // public rotate(update) {
  //   this.rotation = update;
  // }

  public rotate(update) {
    this.localRot = Quat.product(this.localRot, update);
  }
}

export class Mesh {
  public geometry: MeshGeometry;
  public worldMatrix: Mat4; // in this project all meshes and rigs have been transformed into world coordinates for you
  public rotation: Vec3;
  public bones: Bone[];
  public materialName: string;
  public imgSrc: String | null;

  public highlightedBone: Bone = null;
  static readonly DEFAULT_COLOR = [1.0, 0.0, 0.0, 1.0];
  static readonly HIGHLIGHT_COLOR = [0.0, 1.0, 1.0, 1.0];

  private boneIndices: number[];
  private bonePositions: Float32Array;
  private boneIndexAttribute: Float32Array;

  public roots: Bone[] = [];

  constructor(mesh: MeshLoader) {
    this.geometry = new MeshGeometry(mesh.geometry);
    this.worldMatrix = mesh.worldMatrix.copy();
    this.rotation = mesh.rotation.copy();
    this.bones = [];
    mesh.bones.forEach(bone => {
      let thisbone = new Bone(bone);
      this.bones.push(thisbone);
      if (thisbone.parent == -1) {
        this.roots.push(thisbone);
      }
    });
    this.materialName = mesh.materialName;
    this.imgSrc = null;

    this.boneIndices = Array.from(mesh.boneIndices);
    // let startIdx = this.boneIndices.length;
    // this.boneIndices.push(
    //   startIdx, startIdx + 1,
    //   startIdx + 2, startIdx + 3,
    //   startIdx + 4, startIdx + 5);
    // console.log(this.boneIndices);
    
    let newBonePos = Array.from(mesh.bonePositions);
    // let idx = 0;
    // newBonePos.push(
    //   newBonePos[idx * 3], newBonePos[idx * 3 + 1], newBonePos[idx * 3 + 2], 
    //   newBonePos[idx * 3 + 3], newBonePos[idx * 3 + 4], newBonePos[idx * 3 + 5] + .5, 
    // );

    // newBonePos.push(
    //   newBonePos[idx * 3], newBonePos[idx * 3 + 1], newBonePos[idx * 3 + 2], 
    //   newBonePos[idx * 3 + 3], newBonePos[idx * 3 + 4], newBonePos[idx * 3 + 5] - .5, 
    // );

    // newBonePos.push(
    //   newBonePos[idx * 3], newBonePos[idx * 3 + 1], newBonePos[idx * 3 + 2], 
    //   newBonePos[idx * 3 + 3], newBonePos[idx * 3 + 4], newBonePos[idx * 3 + 5] + .8, 
    // );
    // console.log(newBonePos);
    this.bonePositions = new Float32Array(newBonePos);

    let newBoneIndexAttribute = Array.from(mesh.boneIndexAttribute)
    // let idxAttr = newBoneIndexAttribute.length / 2;
    // newBoneIndexAttribute.push(
    //   idxAttr, idxAttr,
    //   idxAttr + 1, idxAttr + 1,
    //   idxAttr + 2, idxAttr + 2
    // );
    // console.log(newBoneIndexAttribute);
    this.boneIndexAttribute = new Float32Array(newBoneIndexAttribute);

    this.bones.forEach(newBone => {this.setTransB(newBone)});
  }

  public setTransB(bone: Bone) {
    let transBji: Mat4 = Mat4.identity.copy();
    
    let c: Vec3 = bone.initialPosition;
    let p: Vec3 = new Vec3([0, 0, 0]);

    if (bone.parent != -1) {
      p = this.bones[bone.parent].initialPosition;
    }

    let vec: Vec3 = Vec3.difference(c, p);
    //console.log(vec);
    transBji = new Mat4([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      vec.x, vec.y, vec.z, 1
    ]);
    bone.transB = transBji;
  }

  public getBoneIndices(): Uint32Array {
    return new Uint32Array(this.boneIndices);
  }

  public getBonePositions(): Float32Array {
    return this.bonePositions;
  }

  public getBoneIndexAttribute(): Float32Array {
    return this.boneIndexAttribute;
  }

  public getBoneTranslations(): Float32Array {
    let trans = new Float32Array(3 * this.bones.length);
    this.bones.forEach((bone, index) => {
      let res = bone.position.xyz;
      for (let i = 0; i < res.length; i++) {
        trans[3 * index + i] = res[i];
      }
    });
    return trans;
  }

  public getBoneRotations(): Float32Array {
    let trans = new Float32Array(4 * this.bones.length);
    this.bones.forEach((bone, index) => {
      let res = bone.rotation.xyzw;
      for (let i = 0; i < res.length; i++) {
        trans[4 * index + i] = res[i];
      }
    });
    return trans;
  }

  public getBoneHighlights(): Float32Array {
    let highlights = new Float32Array(4 * this.bones.length);

    this.bones.forEach((bone, index) => {
      let color = Mesh.DEFAULT_COLOR;
      if (bone == this.highlightedBone) {
        color = Mesh.HIGHLIGHT_COLOR;
      }

      highlights[4 * index + 0] = color[0];
      highlights[4 * index + 1] = color[1];
      highlights[4 * index + 2] = color[2];
      highlights[4 * index + 3] = color[3];
    });

    return highlights;
  }

  public highlightedBoneIndex(): number {
    if (this.highlightedBone == null) {
      return -1;
    }

    for (let i = 0; i < this.bones.length; i++) {
      if (this.bones[i] == this.highlightedBone) {
        return i;
      }
    }

    return -1;
  }

  public rotateBone(bone, update) {
    bone.rotate(update);
    this.updateRotations();
    this.updatePositions();
  }

  public updateRotationsRecursively(bone, update) {
    bone.rotation = Quat.product(bone.localRot, update);
    for (let i of bone.children) {
      this.updateRotationsRecursively(this.bones[i], bone.rotation);
    }
  }

  public updateRotations() {
    this.roots.forEach(bone => {
      bone.rotation = bone.localRot;
      for (let i of bone.children) {
        this.updateRotationsRecursively(this.bones[i], bone.rotation);
      }
    })
  }

  public updatePositions() {
    this.bones.forEach((bone) => {
      bone.position = new Vec3(this.defMatrix(bone).multiplyVec4(new Vec4([0, 0, 0, 1])).xyz);
    })
  }

  public defMatrix(bone) {
    let localRot = bone.localRot.toMat4();

    let prod = Mat4.product(bone.transB, localRot)
    if (bone.parent == -1) {
      return prod;
    }

    return Mat4.product(this.defMatrix(this.bones[bone.parent]), prod);
  }
};