import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const artifactsDir = 'C:\\Users\\Minar\\.gemini\\antigravity\\brain\\36f711bc-f250-4ddc-84b1-c004000f697f';
const publicDir = 'c:\\Users\\Minar\\Documents\\Proyectos\\PuntoEncuentro\\public\\invitation-templates';

const images = [
  { source: 'sports_field_1783286221336.png', targetDir: 'sports', targetName: 'sports_field.webp' },
  { source: 'sports_team_1783286228912.png', targetDir: 'sports', targetName: 'sports_team.webp' },
  { source: 'sports_competition_1783286236224.png', targetDir: 'sports', targetName: 'sports_competition.webp' },
  { source: 'entertainment_cinema_1783286245878.png', targetDir: 'entertainment', targetName: 'entertainment_cinema.webp' },
  { source: 'entertainment_music_1783286254016.png', targetDir: 'entertainment', targetName: 'entertainment_music.webp' },
  { source: 'entertainment_show_1783286262206.png', targetDir: 'entertainment', targetName: 'entertainment_show.webp' }
];

async function processImages() {
  for (const img of images) {
    const srcPath = path.join(artifactsDir, img.source);
    const destDir = path.join(publicDir, img.targetDir);
    const destPath = path.join(destDir, img.targetName);

    // Create target directory if it doesn't exist
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    try {
      await sharp(srcPath)
        .resize(820, 1024, { fit: 'cover' })
        .webp({ quality: 85 })
        .toFile(destPath);
      
      console.log(`Processed ${img.targetName}`);
      
      const stats = fs.statSync(destPath);
      console.log(` - Size: ${(stats.size / 1024).toFixed(2)} KB`);
    } catch (err) {
      console.error(`Failed to process ${img.source}`, err);
    }
  }
}

processImages();
