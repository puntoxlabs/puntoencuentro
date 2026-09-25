import React, { useEffect } from 'react';
import Home from './Home';

const PreviewHomeD: React.FC = () => {
  useEffect(() => {
    let metaTag = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
    let wasCreated = false;
    let previousContent: string | null = null;

    if (!metaTag) {
      metaTag = document.createElement('meta');
      metaTag.name = 'robots';
      document.head.appendChild(metaTag);
      wasCreated = true;
    } else {
      previousContent = metaTag.getAttribute('content');
    }

    metaTag.setAttribute('content', 'noindex, nofollow');

    return () => {
      if (wasCreated) {
        metaTag?.parentNode?.removeChild(metaTag);
      } else if (metaTag) {
        if (previousContent !== null) {
          metaTag.setAttribute('content', previousContent);
        } else {
          metaTag.removeAttribute('content');
        }
      }
    };
  }, []);

  return <Home forcedVariant="stitch" />;
};

export default PreviewHomeD;
