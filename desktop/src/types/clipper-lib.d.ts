declare module 'clipper-lib' {
    export interface IntPoint {
        X: number;
        Y: number;
    }

    export interface ClipperOffsetInstance {
        AddPaths(paths: IntPoint[][], joinType: number, endType: number): void;
        Execute(solution: IntPoint[][], delta: number): void;
    }

    const ClipperLib: {
        ClipperOffset: new (miterLimit?: number, arcTolerance?: number) => ClipperOffsetInstance;
        JoinType: { jtSquare: number; jtRound: number; jtMiter: number };
        EndType: { etClosedPolygon: number };
        Clipper: {
            Orientation(path: IntPoint[]): boolean;
            CleanPolygons(paths: IntPoint[][], distance?: number): IntPoint[][];
        };
    };

    export default ClipperLib;
}