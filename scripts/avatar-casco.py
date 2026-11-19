# Genera el avatar "casco" (casco corintio, por dentro solo oscuridad y dos ojos azules afilados) y lo exporta a GLB para
# public/js/avatar.js.
# Uso: blender -b -P scripts/avatar-casco.py -- public/models/avatar-casco.glb [vista_previa.png]
#
# Lo que avatar.js espera del modelo (todo opcional, pero sin ello no hay gestos):
#  - morph targets viseme_PP/FF/DD/aa/E/I/O/U (boca), mouthSmile, mouthSad, eyeBlink, browUp, browSad, browDown;
#  - nodos Eye_L y Eye_R con el origen en el centro del ojo (se giran para mirar);
#  - un material llamado "Lens" (ahi se refleja el codigo del taller), dividido en x<0 / x>=0.
# No tiene boca: los visemas hacen latir los ojos mientras habla, y mouthSmile/mouthSad cambian la forma de los ojos.
# En Blender el frente mira a -Y; el exportador lo convierte a +Z (hacia la camara de three.js).
import bpy, bmesh, math, random, sys
from mathutils import Vector, Matrix, noise

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else 'public/models/avatar-casco.glb'
PREVIEW = argv[1] if len(argv) > 1 else ''
random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)

RX, RY, RZ, H = 0.95, 1.05, 1.0, 1.15   # radios de la cupula y largo de la parte baja
NA, NS = 160, 72                          # resolucion de la cascara (alrededor, de arriba abajo)

# ---------- materiales ----------
def mat(name, color, metal=0.0, rough=0.5, emit=None, alpha=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*color, 1); p.inputs['Metallic'].default_value = metal; p.inputs['Roughness'].default_value = rough
    if emit:
        p.inputs['Emission Color'].default_value = (*emit, 1); p.inputs['Emission Strength'].default_value = 1.0
    if alpha < 1:
        p.inputs['Alpha'].default_value = alpha
        if hasattr(m, 'surface_render_method'): m.surface_render_method = 'BLENDED'
        if hasattr(m, 'blend_method'): m.blend_method = 'BLEND'
    return m

GOLD = mat('Oro', (0.82, 0.54, 0.18), 0.85, 0.26)
STEEL = mat('Acero', (0.26, 0.27, 0.29), 0.8, 0.36)
INSIDE = mat('Interior', (0.0, 0.0, 0.0), 0.0, 1.0)
CRESTS = [mat('CrestaA', (0.022, 0.06, 0.075), 0.0, 0.85), mat('CrestaB', (0.035, 0.09, 0.11), 0.0, 0.8), mat('CrestaC', (0.055, 0.13, 0.155), 0.0, 0.75)]
GLOW = mat('Luz', (0.0, 0.0, 0.0), 0.0, 1.0, emit=(0.03, 0.38, 1.0))   # solo luz propia: no la aclaran las luces de la escena
CORE = mat('Nucleo', (0.0, 0.0, 0.0), 0.0, 1.0, emit=(0.55, 0.80, 1.0))
HALO = mat('Halo', (0.0, 0.0, 0.0), 0.0, 1.0, emit=(0.0, 0.22, 1.0), alpha=0.45)
LENS = mat('Lens', (0.02, 0.06, 0.08), 0.0, 0.1, alpha=0.12)

# ---------- utilidades ----------
def new_obj(name, verts, faces, mats=(), face_mats=None, smooth=True):
    me = bpy.data.meshes.new(name); me.from_pydata(verts, [], faces); me.update()
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    for m in mats: me.materials.append(m)
    if face_mats:
        for poly, i in zip(me.polygons, face_mats): poly.material_index = i
    for poly in me.polygons: poly.use_smooth = smooth
    return ob

def bake(ob):
    """Aplica los modificadores (o convierte la curva) y deja una malla limpia."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    if ob.type != 'MESH':
        new = bpy.data.objects.new(ob.name, me); bpy.context.collection.objects.link(new); new.matrix_world = ob.matrix_world
        bpy.data.objects.remove(ob); return new
    ob.modifiers.clear(); old = ob.data; ob.data = me; bpy.data.meshes.remove(old)
    return ob

def solidify(ob, thick, offset):
    m = ob.modifiers.new('s', 'SOLIDIFY'); m.thickness = thick; m.offset = offset; m.use_even_offset = True; m.use_quality_normals = True
    return bake(ob)

def boolean(ob, cutter, op):
    m = ob.modifiers.new('b', 'BOOLEAN'); m.operation = op; m.object = cutter; m.solver = 'EXACT'
    return bake(ob)

def outward(ob):
    """Normales hacia afuera (de la cabeza)."""
    bm = bmesh.new(); bm.from_mesh(ob.data)
    for f in bm.faces:
        if f.normal.dot(f.calc_center_median() - Vector((0, 0, -0.3))) < 0: f.normal_flip()
    bm.to_mesh(ob.data); bm.free()

def sharp(ob, deg=35):
    for p in ob.data.polygons: p.use_smooth = True
    if hasattr(ob.data, 'set_sharp_from_angle'): ob.data.set_sharp_from_angle(angle=math.radians(deg))

def smoothstep(x): x = max(0.0, min(1.0, x)); return x * x * (3 - 2 * x)

def catmull(pts, n=6, closed=True):
    out, m = [], len(pts)
    rng = range(m) if closed else range(m - 1)
    for i in rng:
        g = (lambda k: Vector(pts[(i + k) % m])) if closed else (lambda k: Vector(pts[max(0, min(m - 1, i + k))]))
        p0, p1, p2, p3 = g(-1), g(0), g(1), g(2)
        for k in range(n):
            t = k / n
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    if not closed: out.append(Vector(pts[-1]))
    return out

# ---------- superficie del casco ----------
def bottom(a):
    """Hasta donde baja el casco segun el angulo: mejillas largas que terminan en punta junto a la boca, corte bajo la
    oreja y nuca acampanada."""
    aa = abs(a)
    if aa <= 1.75: return 1.0 + 0.05 * math.exp(-((aa - 0.25) / 0.12) ** 2) - 0.45 * math.exp(-((aa - 1.75) / 0.28) ** 2)
    return 0.55 + 0.30 * smoothstep((aa - 1.75) / 0.5)

def surf(a, s, scale=1.0):
    """a: angulo alrededor (0 = frente), s: 0 arriba .. 1 borde inferior. Devuelve el punto en la cara externa."""
    if s <= 0.5:
        p = s / 0.5 * math.pi / 2; h, z, k = math.sin(p), RZ * math.cos(p), 1.0
    else:
        t = (s - 0.5) / 0.5; h, z = 1.0, -t * H
        front, back = max(0.0, math.cos(a)), max(0.0, -math.cos(a))
        k = 1 - 0.22 * t ** 1.6 * front + 0.07 * smoothstep((t - 0.8) / 0.25) * front + 0.14 * t ** 3 * back - 0.05 * t * abs(math.sin(a))
    return Vector((RX * h * k * math.sin(a) * scale, -RY * h * k * math.cos(a) * scale, z))

def normal_at(a, s):
    p = surf(a, s); n = (surf(a + 0.01, s) - surf(a - 0.01, s)).cross(surf(a, s + 0.01) - surf(a, s - 0.01)).normalized()
    return -n if n.dot(p - Vector((0, 0, -0.3))) < 0 else n

def on(a, s, lift=0.0): return surf(a, s) + normal_at(a, s) * lift

def grid(s_of, rows, scale=1.0, cols=NA):
    """Malla cerrada alrededor: s_of(a, f) da la s de la fila f (0..1)."""
    verts, faces = [], []
    for i in range(cols):
        a = -math.pi + 2 * math.pi * i / cols
        for j in range(rows + 1): verts.append(surf(a, s_of(a, j / rows), scale))
    for i in range(cols):
        i2 = (i + 1) % cols
        for j in range(rows): faces.append((i * (rows + 1) + j, i2 * (rows + 1) + j, i2 * (rows + 1) + j + 1, i * (rows + 1) + j + 1))
    return verts, faces

def band_s(a):
    """Centro de la franja dorada de la frente: baja en las sienes como una ceja sobre el final de cada ojo."""
    return 0.47 + 0.035 * math.exp(-((abs(a) - 0.95) / 0.32) ** 2)

# Cascara: polo arriba + filas que terminan justo en el borde inferior de cada columna (borde liso, sin escalones).
verts, faces = grid(lambda a, f: 0.012 + (0.5 + 0.5 * bottom(a) - 0.012) * f, NS)
pole = len(verts); verts.append(Vector((0, 0, RZ)))
for i in range(NA): faces.append((pole, ((i + 1) % NA) * (NS + 1), i * (NS + 1)))
shell = new_obj('Casco', verts, faces, (GOLD, STEEL, INSIDE))
outward(shell)
for p in shell.data.polygons:   # cupula de oro, parte baja de acero (el limite sigue la franja)
    c = p.center; a = math.atan2(c.x, -c.y)
    p.material_index = 0 if c.z > surf(a, band_s(a)).z else 1
shell = solidify(shell, 0.05, -1)
for p in shell.data.polygons:   # la cara interna del casco es negra
    if p.normal.dot(p.center - Vector((0, 0, -0.3))) < -0.3: p.material_index = 2

# Ranura en T vista de frente (x, z): ojos almendrados, guarda nasal y ranura de la boca que se abre hacia abajo.
right = [(0.075, -0.06), (0.25, -0.05), (0.45, -0.10), (0.64, -0.21), (0.50, -0.29), (0.30, -0.33), (0.15, -0.35),
         (0.13, -0.50), (0.16, -0.75), (0.21, -1.00), (0.27, -1.40)]
nose = [(0.07, -0.38), (0.045, -0.55), (0.0, -0.60)]
loop = right + [(-x, z) for x, z in reversed(right)] + [(-x, z) for x, z in nose] + [(x, z) for x, z in reversed(nose[:-1])]
outline = catmull(loop, 6)

def prism(name, pts2d, y0, y1):
    n = len(pts2d)
    v = [Vector((p.x, y0, p.y)) for p in pts2d] + [Vector((p.x, y1, p.y)) for p in pts2d]
    f = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    ob = new_obj(name, v, f, smooth=False)
    bm = bmesh.new(); bm.from_mesh(ob.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(ob.data); bm.free()
    return ob

cut = prism('Corte', outline, -3.0, -0.25)

# Ribete dorado alrededor de la T: una franja que sigue el contorno exacto del hueco (sin escalones), mas ancha arriba de
# los ojos como cejas, apoyada sobre la superficie y con grosor para que sobresalga.
def front_point(x, z, lift=0.0):
    """Punto de la superficie del casco (al frente) con esa x y esa z: se busca el angulo a por Newton."""
    s = math.acos(max(-1.0, min(1.0, z / RZ))) / math.pi if z >= 0 else 0.5 + 0.5 * (-z / H)
    a = math.asin(max(-0.99, min(0.99, x / RX)))
    for _ in range(10):
        px = surf(a, s).x
        if abs(px - x) < 1e-5: break
        a += (x - px) / max(0.2, (surf(a + 1e-3, s).x - px) / 1e-3)
    return on(a, s, lift)

ol = catmull(loop, 12); n_ = len(ol)
area = sum(ol[i].x * ol[(i + 1) % n_].y - ol[(i + 1) % n_].x * ol[i].y for i in range(n_)); sgn = 1 if area > 0 else -1
tv, tf = [], []
for i in range(n_):
    p = ol[i]; t = (ol[(i + 1) % n_] - ol[i - 1]).normalized(); nrm = Vector((t.y, -t.x)) * sgn
    w = 0.05 + (0.03 * smoothstep((p.y + 0.36) / 0.12) if abs(p.x) > 0.09 else 0)   # cejas mas anchas
    for k in range(3):
        q = p + nrm * (w * k / 2); tv.append(front_point(q.x, q.y, 0.0))
for i in range(n_):
    i2 = (i + 1) % n_
    if min(ol[i].y, ol[i2].y) < -H * 1.02: continue   # la ranura de la boca sigue mas abajo que el casco
    if max(abs(ol[i].x), abs(ol[i2].x)) < 0.06 and min(ol[i].y, ol[i2].y) < -0.5: continue   # punta de la nariz: la cubre la guarda
    for k in range(2): tf.append((i * 3 + k, i2 * 3 + k, i2 * 3 + k + 1, i * 3 + k + 1))
trim = new_obj('RibeteT', tv, tf, (GOLD,)); outward(trim)
trim = solidify(trim, 0.095, -0.45)
# Guarda nasal dorada completa (la franja de los dos lados se juntaria con un hueco al centro).
nv, nf, NXn, NZn = [], [], 8, 40
for i in range(NXn + 1):
    for j in range(NZn + 1):
        z = -0.04 - 0.58 * j / NZn; half = 0.072 if z > -0.38 else 0.072 - 0.027 * (z + 0.38) / -0.17 if z > -0.55 else max(0.0, 0.045 * (1 - (z + 0.55) / -0.05))
        nv.append(front_point(-half + 2 * half * i / NXn, z))
for i in range(NXn):
    for j in range(NZn): nf.append((i * (NZn + 1) + j, (i + 1) * (NZn + 1) + j, (i + 1) * (NZn + 1) + j + 1, i * (NZn + 1) + j + 1))
nose_g = new_obj('Nariz', nv, nf, (GOLD,)); outward(nose_g); nose_g = solidify(nose_g, 0.095, -0.38)
shell = boolean(shell, cut, 'DIFFERENCE')

# Franja dorada de la frente (ondulada) y ribete del borde inferior.
band = new_obj('Banda', *grid(lambda a, f: band_s(a) - 0.03 + 0.06 * f, 4), (GOLD,)); outward(band); band = solidify(band, 0.09, -0.5)
band = boolean(band, cut, 'DIFFERENCE')
rim = new_obj('Borde', *grid(lambda a, f: 0.5 + 0.5 * bottom(a) - 0.026 + 0.026 * f, 3), (GOLD,)); outward(rim); rim = solidify(rim, 0.09, -0.5)
rim = boolean(rim, cut, 'DIFFERENCE')

# ---------- adornos ----------
parts = []
def add_prim(kind, **kw):
    getattr(bpy.ops.mesh, f'primitive_{kind}_add')(**kw); return bpy.context.active_object

def place(ob, a, s, lift=0.0, toward=None):
    """Pone ob sobre la superficie con su Z en la normal; `toward` (da, ds) orienta su X sobre la superficie."""
    p, n = surf(a, s), normal_at(a, s)
    if toward:
        tx = (surf(a + toward[0] * 0.01, s + toward[1] * 0.01) - p); tx = (tx - n * tx.dot(n)).normalized(); ty = n.cross(tx)
        rot = Matrix((tx, ty, n)).transposed().to_4x4()
    else: rot = n.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    ob.matrix_world = Matrix.Translation(p + n * lift) @ rot
    return ob

def tube(name, pts, radius, material, taper=None):
    """Tubo dorado que sigue una lista de puntos (espirales, volutas, el gancho de la nuca)."""
    cu = bpy.data.curves.new(name, 'CURVE'); cu.dimensions = '3D'; cu.bevel_depth = radius; cu.bevel_resolution = 3; cu.use_fill_caps = True
    sp = cu.splines.new('POLY'); sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (*p, 1); sp.points[i].radius = taper(i / (len(pts) - 1)) if taper else 1.0
    ob = bpy.data.objects.new(name, cu); bpy.context.collection.objects.link(ob)
    ob = bake(ob); ob.data.materials.append(material); return ob

def diamond(a, s, size, lift):
    g = add_prim('cylinder', vertices=4, radius=size, depth=size * 0.5); g.data.materials.append(GOLD)
    bm = bmesh.new(); bm.from_mesh(g.data)          # punta piramidal al frente
    for v in bm.verts:
        if v.co.z > 0: v.co.z += size * 0.25 * (1 - min(1, Vector((v.co.x, v.co.y)).length / size))
    bm.to_mesh(g.data); bm.free()
    place(g, a, s, lift); g.scale = (0.68, 1.15, 1); parts.append(g)
    inner = add_prim('cylinder', vertices=4, radius=size * 0.55, depth=size * 0.6); inner.data.materials.append(GOLD)
    place(inner, a, s, lift + size * 0.12); inner.scale = (0.68, 1.15, 1); parts.append(inner)

# Rombos: frente y sienes (sobre la franja, donde baja como ceja).
diamond(0, band_s(0), 0.085, 0.05)
for side in (-1, 1): diamond(side * 0.98, band_s(0.98) - 0.004, 0.11, 0.05)

# Remaches a lo largo de la franja.
for k in range(44):
    a = -math.pi + 2 * math.pi * (k + 0.5) / 44
    if abs(a) < 0.2 or abs(abs(a) - 0.98) < 0.16: continue
    r = add_prim('uv_sphere', segments=12, ring_count=6, radius=0.017); r.data.materials.append(GOLD); place(r, a, band_s(a), 0.035); parts.append(r)

# Mejillas: disco con punta (como una daga hacia la boca), volutas y espiral, como en la referencia.
for side in (-1, 1):
    d = add_prim('cylinder', vertices=40, radius=0.085, depth=0.03); d.data.materials.append(GOLD); place(d, side * 0.66, 0.77, 0.015); parts.append(d)
    ring_ = add_prim('torus', major_radius=0.085, minor_radius=0.013, major_segments=40, minor_segments=8); ring_.data.materials.append(GOLD)
    place(ring_, side * 0.66, 0.77, 0.03); parts.append(ring_)
    b = add_prim('uv_sphere', segments=24, ring_count=12, radius=0.045); b.data.materials.append(GOLD); place(b, side * 0.66, 0.77, 0.032); b.scale = (1, 1, 0.5); parts.append(b)
    spike = add_prim('cone', vertices=4, radius1=0.035, radius2=0.0, depth=0.24); spike.data.materials.append(GOLD)
    bm = bmesh.new(); bm.from_mesh(spike.data); bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(math.radians(90), 3, 'Y')); bm.to_mesh(spike.data); bm.free()
    place(spike, side * 0.45, 0.80, 0.022, toward=(-side, 0.35)); spike.scale = (1, 1, 0.45); parts.append(spike)
    # Voluta: baja desde el borde inferior del ojo y se enrosca hacia el disco.
    vol = [(0.50, 0.655), (0.58, 0.68), (0.62, 0.71), (0.58, 0.735), (0.52, 0.73)]
    pts = [on(side * a, s, 0.03) for a, s in (tuple(p) for p in catmull(vol, 8, closed=False))]
    parts.append(tube('Voluta', pts, 0.016, GOLD, taper=lambda u: 1.0 - 0.5 * u))
    # Espiral bajo el disco.
    sp = []
    for k in range(70):
        u = k / 69; ang = u * 2.1 * 2 * math.pi; r = 0.012 + 0.075 * u
        sp.append(on(side * (0.50 + side * 0 + r * math.cos(ang) / 0.95), 0.90 + r * math.sin(ang) / 2.3, 0.025))
    parts.append(tube('Espiral', sp, 0.014, GOLD, taper=lambda u: 0.6 + 0.4 * u))
    sm = add_prim('cylinder', vertices=28, radius=0.035, depth=0.03); sm.data.materials.append(GOLD); place(sm, side * 0.36, 0.97, 0.015); parts.append(sm)

# ---------- cresta ----------
def crest_base(th): return Vector((0, RY * math.sin(th), RZ * math.cos(th)))
def crest_normal(th): return Vector((0, math.sin(th) / RY, math.cos(th) / RZ)).normalized()
def crest_tan(th): return Vector((0, math.cos(th) * RY, -math.sin(th) * RZ)).normalized()
T0, T1 = math.radians(-40), math.radians(102)

# Soporte: una moldura a lo largo y encima placas doradas separadas, como un peine (mas altas al frente).
ridge = [crest_base(T0 + (T1 - T0) * k / 60) + crest_normal(T0 + (T1 - T0) * k / 60) * 0.03 for k in range(61)]
parts.append(tube('Moldura', ridge, 0.05, GOLD))
NSL = 24
for k in range(NSL):
    u = (k + 0.5) / NSL; th = T0 + (T1 - T0) * u; n, tg = crest_normal(th), crest_tan(th)
    hgt = 0.20 - 0.07 * u
    blk = add_prim('cube', size=1); blk.data.materials.append(GOLD)
    blk.matrix_world = Matrix.Translation(crest_base(th) + n * (0.05 + hgt / 2)) @ Matrix((Vector((1, 0, 0)), tg, n)).transposed().to_4x4() @ Matrix.Diagonal((0.20, 0.07, hgt, 1))
    parts.append(blk)
    cap = add_prim('cube', size=1); cap.data.materials.append(GOLD)   # reborde de cada placa
    cap.matrix_world = Matrix.Translation(crest_base(th) + n * (0.05 + hgt)) @ Matrix((Vector((1, 0, 0)), tg, n)).transposed().to_4x4() @ Matrix.Diagonal((0.22, 0.085, 0.025, 1))
    parts.append(cap)

# Cerdas: muchas columnas finas con largo y abertura irregulares; se abren en abanico hacia las puntas.
NC, NR = 300, 6
cv, cf, cm = [], [], []
for i in range(NC + 1):
    u = i / NC; th = T0 + (T1 - T0) * u
    hgt = (0.30 + 0.85 * math.sin(math.pi * min(1.0, u * 1.12)) ** 0.65) * (1 + random.uniform(-0.09, 0.09))
    base, n = crest_base(th) + crest_normal(th) * 0.2, crest_normal(th)
    sweep = Vector((0, -0.22 * (1 - u) ** 2, 0)); jx = random.uniform(-0.035, 0.035)
    for r in range(NR + 1):
        f = r / NR; w = 0.085 + 0.06 * f ** 1.2 - 0.12 * f ** 6
        p = base + n * hgt * f + sweep * f + Vector((jx * f * f, 0, 0))
        cv += [p + Vector((max(w, 0.005), 0, 0)), p + Vector((-max(w, 0.005), 0, 0))]
row = (NR + 1) * 2
for i in range(NC):
    m_ = random.choice((0, 0, 1, 1, 2))
    for r in range(NR):
        a0, b0 = i * row + r * 2, (i + 1) * row + r * 2
        cf += [(a0, b0, b0 + 2, a0 + 2), (a0 + 1, a0 + 3, b0 + 3, b0 + 1)]; cm += [m_, m_]
    t0, t1 = i * row + NR * 2, (i + 1) * row + NR * 2
    cf.append((t0, t0 + 1, t1 + 1, t1)); cm.append(m_)
for i in (0, NC):
    for r in range(NR):
        a0 = i * row + r * 2; cf.append((a0, a0 + 2, a0 + 3, a0 + 1)); cm.append(0)
crest = new_obj('Cresta', cv, cf, CRESTS, cm)

# Gancho dorado en la nuca: baja desde el final de la cresta y se enrosca hacia afuera.
hook = [crest_base(T1) + crest_normal(T1) * 0.08, Vector((0, 1.13, -0.30)), Vector((0, 1.22, -0.55)), Vector((0, 1.38, -0.72)),
        Vector((0, 1.52, -0.70)), Vector((0, 1.55, -0.60)), Vector((0, 1.47, -0.55))]
parts.append(tube('Gancho', catmull(hook, 8, closed=False), 0.045, GOLD, taper=lambda u: 1.0 - 0.65 * u))

# ---------- interior negro ----------
# Dentro del casco no hay cara: solo oscuridad y los ojos. Una esfera negra mate tapa lo que se veria por las ranuras.
inner = add_prim('uv_sphere', segments=40, ring_count=24, radius=1); inner.name = 'Interior'
inner.location = (0, 0.15, -0.3); inner.scale = (0.85, 0.95, 0.85); inner.data.materials.append(INSIDE)

# ---------- ojos de luz ----------
# Ojos afilados: un poligono anguloso con la punta exterior hacia arriba (mirada dura), en tres capas: halo translucido
# detras, cuerpo azul brillante y un nucleo claro adelante (al girar el ojo para mirar, el nucleo se desplaza).
EYE = [(-0.115, -0.012), (-0.075, 0.026), (0.02, 0.040), (0.13, 0.064), (0.08, -0.010), (-0.02, -0.040)]

def slab(pts, y0, y1):
    n = len(pts)
    v = [Vector((x, y0, z)) for x, z in pts] + [Vector((x, y1, z)) for x, z in pts]
    f = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    return v, f

def make_eye(name, x, z):
    side = 1 if x > 0 else -1   # +X es la izquierda del personaje; la punta va hacia afuera
    base = [(side * u, w) for u, w in EYE]
    cx = sum(p[0] for p in base) / len(base); cz = sum(p[1] for p in base) / len(base)
    scaled = lambda k: [(cx + (px - cx) * k, cz + (pz - cz) * k) for px, pz in base]
    v, f, mi = [], [], []
    for pts, y0, y1, m_ in ((scaled(1.4), 0.010, 0.014, 2), (base, -0.010, 0.010, 0), (scaled(0.45), -0.018, -0.008, 1)):
        sv, sf = slab(pts, y0, y1); off = len(v)
        v += sv; f += [tuple(i + off for i in q) for q in sf]; mi += [m_] * len(sf)
    ob = new_obj(name, v, f, (GLOW, CORE, HALO), mi, smooth=False); ob.location = (x, -0.84, z)
    keys = {
        'eyeBlink': lambda p: Vector((p.x, p.y, cz + (p.z - cz) * 0.08)),
        'browUp': lambda p: Vector((p.x * 1.05, p.y, p.z * 1.35 + 0.012)),
        'browDown': lambda p: Vector((p.x, p.y, cz + (p.z - cz) * 0.45 if p.z > cz else p.z)),
        'browSad': lambda p: Vector((p.x, p.y, p.z * 0.85 - 0.30 * p.x * side + 0.004)),
        'mouthSmile': lambda p: Vector((p.x, p.y, cz + (p.z - cz) * 0.4 if p.z < cz else p.z)),          # ojos que sonrien
        'mouthSad': lambda p: Vector((p.x, p.y, p.z - 0.12 * abs(p.x) * (1 if p.x * side > 0 else 0))),
    }
    # Sin boca: al hablar los ojos laten un poco con cada sonido (los visemas los agrandan).
    for vis, k in (('viseme_aa', 1.0), ('viseme_O', 0.9), ('viseme_E', 0.75), ('viseme_I', 0.6), ('viseme_U', 0.6),
                   ('viseme_DD', 0.5), ('viseme_FF', 0.4), ('viseme_PP', 0.25)):
        keys[vis] = (lambda k: lambda p: Vector((cx + (p.x - cx) * (1 + 0.10 * k), p.y, cz + (p.z - cz) * (1 + 0.28 * k))))(k)
    ob.shape_key_add(name='Basis')
    for k, fn in keys.items():
        sk = ob.shape_key_add(name=k, from_mix=False); sk.value = 0
        for i, p in enumerate(v): sk.data[i].co = fn(p)
    return ob

eyes = [make_eye('Eye_L', 0.30, -0.20), make_eye('Eye_R', -0.30, -0.20)]

# Cristal de las ranuras de los ojos (material Lens): un trozo de la cara interna, mas grande que el hueco.
lv, lf, NL, NLs = [], [], 48, 10
for i in range(NL + 1):
    a = -0.95 + 1.9 * i / NL
    for j in range(NLs + 1): lv.append(surf(a, 0.505 + 0.17 * j / NLs, 0.925))
for i in range(NL):
    for j in range(NLs): lf.append((i * (NLs + 1) + j, i * (NLs + 1) + j + 1, (i + 1) * (NLs + 1) + j + 1, (i + 1) * (NLs + 1) + j))
lens = new_obj('Cristal', lv, lf, (LENS,)); outward(lens)

# ---------- unir, desgastar y exportar ----------
bpy.data.objects.remove(cut)
for ob in (shell, trim, band, rim, nose_g): sharp(ob, 40)
sharp(crest, 60)
for ob in parts: ob.data.polygons.foreach_set('use_smooth', [True] * len(ob.data.polygons))
bpy.ops.object.select_all(action='DESELECT')
for ob in parts + [band, rim, trim, nose_g]: ob.select_set(True)
bpy.context.view_layer.objects.active = shell; shell.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.join()
shell.name = 'Casco'
bpy.context.view_layer.objects.active = inner; bpy.ops.object.select_all(action='DESELECT'); inner.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

def weather(ob, amount, cracks):
    """Desgaste en color por vertice: manchas suaves y rayones finos (se multiplica por el color del material)."""
    me = ob.data; attr = me.color_attributes.new('Desgaste', 'BYTE_COLOR', 'POINT')
    for i, v in enumerate(me.vertices):
        p = v.co
        blot = 0.5 + 0.5 * noise.noise(p * 2.3)
        line = 1 - smoothstep(abs(noise.noise(p * 5.5 + Vector((3, 1, 7)))) / 0.045)
        val = 1 - amount * blot - cracks * line * (0.5 + 0.5 * noise.noise(p * 1.7))
        attr.data[i].color = (val, val, val * 0.98, 1)
    me.color_attributes.active_color = attr
    if hasattr(me.color_attributes, 'render_color_index'): me.color_attributes.render_color_index = me.color_attributes.active_color_index
weather(shell, 0.16, 0.4)

opts = dict(filepath=OUT, export_format='GLB', export_yup=True, export_apply=False, export_morph=True, export_morph_normal=False,
            export_cameras=False, export_lights=False)
try: bpy.ops.export_scene.gltf(**opts, export_vertex_color='ACTIVE')
except TypeError: bpy.ops.export_scene.gltf(**opts, export_colors=True)
print('exportado', OUT, sum(len(o.data.polygons) for o in bpy.data.objects if o.type == 'MESH'), 'caras')

# ---------- vista previa (opcional) ----------
if PREVIEW:
    for m in bpy.data.materials:   # que el render use tambien el desgaste
        if m.name in ('Oro', 'Acero'):
            nt = m.node_tree; p = nt.nodes['Principled BSDF']; col = nt.nodes.new('ShaderNodeVertexColor'); col.layer_name = 'Desgaste'
            mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'; mix.inputs[0].default_value = 1
            mix.inputs[6].default_value = p.inputs['Base Color'].default_value
            nt.links.new(col.outputs['Color'], mix.inputs[7]); nt.links.new(mix.outputs[2], p.inputs['Base Color'])
    sc = bpy.context.scene; sc.render.engine = 'CYCLES'; sc.cycles.samples = 48; sc.cycles.device = 'CPU'
    sc.render.resolution_x = sc.render.resolution_y = 800
    w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.32, 0.34, 0.38, 1)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.lens = 120
    for nm, loc, e in (('k', (-3, -6, 5), 900), ('r', (4, 3, 3), 400)):
        L = bpy.data.objects.new(nm, bpy.data.lights.new(nm, 'POINT')); L.data.energy = e; L.location = loc; sc.collection.objects.link(L)
    for tag, ang, zt in (('frente', 0, 0.35), ('tres_cuartos', 35, 0.35), ('cara', 0, -0.4)):
        r = 13 if tag != 'cara' else 7; cam.location = (r * math.sin(math.radians(ang)), -r * math.cos(math.radians(ang)), 0.6 if tag != 'cara' else -0.3)
        cam.rotation_euler = (Vector((0, 0, zt)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = PREVIEW.replace('.png', f'_{tag}.png'); bpy.ops.render.render(write_still=True)
