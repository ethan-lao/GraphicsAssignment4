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
  static readonly CYL_RADIUS: number = .07;

  public localRot;
  public relativePos;

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
    this.relativePos = Mat4.identity.copy();
  }

  public intersect(pos: Vec3, dir: Vec3): number {
    let start = this.position;
    let end = this.endpoint;
    let boneDir = Vec3.difference(end, start)
    boneDir = this.rotation.multiplyVec3(boneDir);
    boneDir = boneDir.normalize();

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

  public rotate(update) {
    this.localRot = Quat.product(this.localRot, update);
  }

  public hasParent() {
    return this.parent != -1;
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
  static readonly HIGHLIGHT_COLOR = [0.0, 0.0, 0.0, 0.0];
  static readonly OFF_SCREEN = 5000;

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
      if (!thisbone.hasParent()) {
        this.roots.push(thisbone);
      }
    });
    this.materialName = mesh.materialName;
    this.imgSrc = null;

    this.boneIndices = Array.from(mesh.boneIndices);
    let numBoneIndices = this.boneIndices.length;
    for (let i = 0; i < numBoneIndices / 2; i++) {
      let startIdx = this.boneIndices.length;
      this.boneIndices.push(
        startIdx, startIdx + 1,
        startIdx + 2, startIdx + 3,
        startIdx + 4, startIdx + 5,
        startIdx + 6, startIdx + 7);
    }
    
    console.log(this.boneIndices);
    
    let oldBonePos = Array.from(mesh.bonePositions);
    let newBonePos = Array.from(mesh.bonePositions);
    for (let i = 0; i < oldBonePos.length / 6; i += 1) {
      for (let j = 0; j < 4; j++) {
        newBonePos.push(
          oldBonePos[6 * i],
          oldBonePos[6 * i + 1],
          oldBonePos[6 * i + 2],
          oldBonePos[6 * i + 3],
          oldBonePos[6 * i + 4],
          oldBonePos[6 * i + 5]);
      }
    }
    console.log(newBonePos);
    this.bonePositions = new Float32Array(newBonePos);

    let newBoneIndexAttribute = Array.from(mesh.boneIndexAttribute)
    let numIndexAttrs = newBoneIndexAttribute.length;
    for (let i = 0; i < numIndexAttrs / 2; i++) {
      let idxAttr = newBoneIndexAttribute.length / 2;
      newBoneIndexAttribute.push(
        idxAttr, idxAttr,
        idxAttr + 1, idxAttr + 1,
        idxAttr + 2, idxAttr + 2,
        idxAttr + 3, idxAttr + 3
      );
    }
    
    console.log(newBoneIndexAttribute);
    this.boneIndexAttribute = new Float32Array(newBoneIndexAttribute);

    this.bones.forEach(newBone => {
      this.setRelativePos(newBone)
    });
  }

  public setRelativePos(bone: Bone) { 
    let c: Vec3 = bone.initialPosition;
    if (bone.hasParent()) {
      c = Vec3.difference(c, this.bones[bone.parent].initialPosition);
    }

    bone.relativePos = new Mat4([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      c.x, c.y, c.z, 1
    ]);
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
    let trans = new Float32Array(3 * (this.bones.length * 5));
    let numbones = this.bones.length;
    this.bones.forEach((bone, index) => {
      let res = bone.position.xyz;
      for (let i = 0; i < res.length; i++) {
        trans[3 * index + i] = res[i];
      }

      if (bone == this.highlightedBone) {
        let boneVec = Vec3.difference(bone.endpoint, bone.position);
        boneVec = bone.rotation.multiplyVec3(boneVec);
        boneVec = boneVec.normalize();

        let dir1 = new Vec3([0.61324, 0.1259812, 0.35284]);
        dir1 = dir1.normalize();
        dir1 = Vec3.difference(dir1, boneVec.scale(Vec3.dot(dir1, boneVec)));
        dir1 = dir1.normalize();
        let dir2 = Vec3.cross(dir1, boneVec);
        dir2 = dir2.normalize();

        dir1 = dir1.scale(Bone.CYL_RADIUS)
        dir2 = dir2.scale(Bone.CYL_RADIUS)

        // console.log(dir1);
        // console.log(dir2);

        trans[(3 * numbones) + (12 * index) + 0 + 0] = res[0] + (dir1.x);
        trans[(3 * numbones) + (12 * index) + 0 + 1] = res[1] + (dir1.y);
        trans[(3 * numbones) + (12 * index) + 0 + 2] = res[2] + (dir1.z);

        trans[(3 * numbones) + (12 * index) + 3 + 0] = res[0] - (dir1.x);
        trans[(3 * numbones) + (12 * index) + 3 + 1] = res[1] - (dir1.y);
        trans[(3 * numbones) + (12 * index) + 3 + 2] = res[2] - (dir1.z);

        trans[(3 * numbones) + (12 * index) + 6 + 0] = res[0] + (dir2.x);
        trans[(3 * numbones) + (12 * index) + 6 + 1] = res[1] + (dir2.y);
        trans[(3 * numbones) + (12 * index) + 6 + 2] = res[2] + (dir2.z);

        trans[(3 * numbones) + (12 * index) + 9 + 0] = res[0] - (dir2.x);
        trans[(3 * numbones) + (12 * index) + 9 + 1] = res[1] - (dir2.y);
        trans[(3 * numbones) + (12 * index) + 9 + 2] = res[2] - (dir2.z);
        // trans[(3 * numbones) + (12 * index) + 0 + 0] = res[0] + (dir1[0] * Bone.CYL_RADIUS);
        // trans[(3 * numbones) + (12 * index) + 0 + 1] = res[1] + (dir1[1] * Bone.CYL_RADIUS);
        // trans[(3 * numbones) + (12 * index) + 0 + 2] = res[2] + (dir1[2] * Bone.CYL_RADIUS);

        // trans[(3 * numbones) + (12 * index) + 3 + 0] = res[0] - (dir1[0] * Bone.CYL_RADIUS);
        // trans[(3 * numbones) + (12 * index) + 3 + 1] = res[1] - (dir1[1] * Bone.CYL_RADIUS);
        // trans[(3 * numbones) + (12 * index) + 3 + 2] = res[2] - (dir1[2] * Bone.CYL_RADIUS);

        // trans[(3 * numbones) + (12 * index) + 6 + 0] = res[0] + (dir2[0] * Bone.CYL_RADIUS);
        // trans[(3 * numbones) + (12 * index) + 6 + 1] = res[1] + (dir2[1] * Bone.CYL_RADIUS);
        // trans[(3 * numbones) + (12 * index) + 6 + 2] = res[2] + (dir2[2] * Bone.CYL_RADIUS);

        // trans[(3 * numbones) + (12 * index) + 9 + 0] = res[0] - (dir2[0] * Bone.CYL_RADIUS);
        // trans[(3 * numbones) + (12 * index) + 9 + 1] = res[1] - (dir2[1] * Bone.CYL_RADIUS);
        // trans[(3 * numbones) + (12 * index) + 9 + 2] = res[2] - (dir2[2] * Bone.CYL_RADIUS);
      } else {
        for (let i = 0; i < res.length; i++) {
          trans[(3 * numbones) + (12 * index) + 0 + i] = Mesh.OFF_SCREEN;
          trans[(3 * numbones) + (12 * index) + 3 + i] = Mesh.OFF_SCREEN;
          trans[(3 * numbones) + (12 * index) + 6 + i] = Mesh.OFF_SCREEN;
          trans[(3 * numbones) + (12 * index) + 9 + i] = Mesh.OFF_SCREEN;
        }
      }
    });

    // if (this.highlightedBone != null) {
    //   for (let idx = this.bones.length; idx < this.bones.length + 4; idx++) {
    //     let res = this.highlightedBone.position.xyz;
    //     for (let i = 0; i < res.length; i++) {
    //       trans[3 * idx + i] = res[i];
    //     }
    //   }

    //   // bone 1
    //   trans[3 * this.bones.length] += Bone.CYL_RADIUS;

    //   // bone 2
    //   trans[3 * (this.bones.length + 1)] -= Bone.CYL_RADIUS;

    //   // bone 3
    //   trans[3 * (this.bones.length + 2) + 2] += Bone.CYL_RADIUS;

    //   // bone 4
    //   trans[3 * (this.bones.length + 3) + 2] -= Bone.CYL_RADIUS;

    // } else {
    //   // place off screen
    //   for (let idx = this.bones.length; idx < this.bones.length + 4; idx++) {
    //     for (let i = 0; i < 3; i++) {
    //       trans[3 * idx + i] = 5000;
    //     }
    //   }
    // }

    return trans;
  }

  public getBoneRotations(): Float32Array {
    let trans = new Float32Array(4 * (this.bones.length * 5));
    let numbones = this.bones.length;
    this.bones.forEach((bone, index) => {
      let res = bone.rotation.xyzw;
      for (let i = 0; i < res.length; i++) {
        trans[4 * index + i] = res[i];

        trans[(4 * numbones) + (16 * index) + 0 + i] = res[i];
        trans[(4 * numbones) + (16 * index) + 4 + i] = res[i];
        trans[(4 * numbones) + (16 * index) + 8 + i] = res[i];
        trans[(4 * numbones) + (16 * index) + 12 + i] = res[i];
      }
    });

    // if (this.highlightedBone != null) {
    //   for (let idx = this.bones.length; idx < this.bones.length + 4; idx++) {
    //     let res = this.highlightedBone.rotation.xyzw;
    //     for (let i = 0; i < res.length; i++) {
    //       trans[4 * idx + i] = res[i];
    //     }
    //   }
    // }

    return trans;
  }

  // returns the color of bones
  public getBoneHighlights(): Float32Array {
    let highlights = new Float32Array(4 * (this.bones.length * 5));

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

  // get the index of the highlighted bone
  public highlightedBoneIndex(): number {
    // done if no bone is highlighted anyways
    if (this.highlightedBone == null) {
      return -1;
    }

    // loop through all bones
    for (let i = 0; i < this.bones.length; i++) {
      if (this.bones[i] == this.highlightedBone) {
        return i;
      }
    }

    return -1;
  }

  // rotates a bone by update, propogate effects
  public rotateBone(bone, update) {
    bone.rotate(update);
    this.updateRotations();
    this.updatePositions();
  }

  // updates bone rotations
  public updateRotationsRecursively(bone, update) {
    bone.rotation = Quat.product(bone.localRot, update);
    for (let i of bone.children) {
      this.updateRotationsRecursively(this.bones[i], bone.rotation);
    }
  }

  // update all bone rotations starting from root bones
  public updateRotations() {
    this.roots.forEach(bone => {
      bone.rotation = bone.localRot;
      for (let i of bone.children) {
        this.updateRotationsRecursively(this.bones[i], bone.rotation);
      }
    })
  }

  // update all bone positions
  public updatePositionsRecursively(bone, update) {
    let prod = Mat4.product(bone.relativePos, bone.localRot.toMat4())
    let thisUpdate = Mat4.product(update, prod);
    bone.position = new Vec3(thisUpdate.multiplyVec4(new Vec4([0, 0, 0, 1])).xyz);
    for (let i of bone.children) {
      this.updatePositionsRecursively(this.bones[i], thisUpdate);
    }
  }

  // update all bone positions starting from root bones
  public updatePositions() {
    this.roots.forEach(bone => {
      let update = Mat4.product(bone.relativePos, bone.localRot.toMat4())
      bone.position = new Vec3(update.multiplyVec4(new Vec4([0, 0, 0, 1])).xyz);
      for (let i of bone.children) {
        this.updatePositionsRecursively(this.bones[i], update);
      }
    })
  }
};