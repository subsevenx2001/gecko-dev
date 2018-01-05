# ANGLE_gyp2mozbuild
gyp to mozbuild scripts extract form Mozila's ANGLE fork.

How to use it
======================================================
1. Copy all files here to an ANGLE repository (/path/to/ANGLE)
2. Apply the git patches to ANGLE
3. Execute gyp_mozbuild
4. Manually fix moz.build under /path/to/ANGLE/src/libANGLE

--(1) Move '../third_party/systeminfo/SystemInfo.cpp' from SOURCES to UNIFIED_SOURCE above.
--(2) Move 'renderer/d3d/d3d11/win32/NativeWindow11Win32.cpp' from UNIFIED_SOURCE to SOURCE below

5. rm -rf /path/to/gecko/gfx/angle
6. mkdir -p /path/to/gecko/gfx/angle
7. cp -r /path/to/ANGLE/[A-Z]* /path/to/ANGLE/{include,src,moz.build} /path/to/gecko/gfx/angle
8. cd /path/to/gecko
9. git add gfx/angle
10. git add -f gfx/angle/src/id
11. git commit
12. Build
