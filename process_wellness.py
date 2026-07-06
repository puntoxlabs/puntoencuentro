from PIL import Image
import os
import shutil

# Map the 3 files to wellness_nature, wellness_calm, wellness_movement
f1 = r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\media__1783362805369.jpg"
f2 = r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\media__1783362805374.jpg"
f3 = r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\media__1783362805449.jpg"

# From colors, f3 is nature
nature_src = f3
# We will guess f1 is calm and f2 is movement
calm_src = f2
movement_src = f1

files = {
    nature_src: r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\wellness\wellness_nature_v1.webp",
    calm_src: r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\wellness\wellness_calm_v1.webp",
    movement_src: r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\wellness\wellness_movement_v1.webp"
}

TARGET_W = 820
TARGET_H = 1024

for src, dst in files.items():
    print(f"Processing {src} -> {dst}")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    img = Image.open(src)
    
    # We want to crop the bottom to remove the watermark
    # The watermark is small at the bottom right.
    # Let's crop 64px from the bottom.
    # New height = 1024 - 64 = 960
    # To maintain 4:5 ratio, new width = 960 * (4/5) = 768
    # Original width = 824. We crop (824 - 768)/2 = 28px from left and right.
    
    box = (28, 0, 824-28, 1024-64)
    img_cropped = img.crop(box)
    
    # Now resize to 820x1024 exactly
    img_final = img_cropped.resize((TARGET_W, TARGET_H), Image.Resampling.LANCZOS)
    
    # Save as webp
    img_final.save(dst, 'WEBP', quality=85)
    print(f"Saved {dst}")
