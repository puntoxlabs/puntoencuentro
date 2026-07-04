const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const inputDir = 'C:\\Users\\Minar\\.gemini\\antigravity\\brain\\91661fe7-d620-4248-88a8-6e6fc00afe58';
const outputDir = 'c:\\Users\\Minar\\Documents\\Proyectos\\PuntoEncuentro\\public\\invitation-templates\\friends';

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const files = [
  { in: 'friends_coffee_1783202387245.png', out: 'friends_coffee.webp' },
  { in: 'friends_night_1783202396243.png', out: 'friends_night.webp' },
  { in: 'friends_picnic_1783202403837.png', out: 'friends_picnic.webp' }
];

async function processImages() {
  for (const file of files) {
    const inputPath = path.join(inputDir, file.in);
    const outputPath = path.join(outputDir, file.out);
    
    // The generated images are usually 1024x1024. We want 820x1024.
    // We will extract a center crop of 820x1024.
    await sharp(inputPath)
      .extract({ left: 102, top: 0, width: 820, height: 1024 })
      .webp({ quality: 85 })
      .toFile(outputPath);
    console.log(`Processed ${file.out}`);
  }
}

processImages().catch(console.error);
