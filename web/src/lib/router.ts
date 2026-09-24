import { useState, useEffect } from 'react';

export function useNavigate() {
  return (hash: string) => {
    window.location.hash = hash;
  };
}

export function useRoute() {
  const [route, setRoute] = useState(() => location.hash.replace(/^#\/?/, ''));
  
  useEffect(() => {
    const onHash = () => setRoute(location.hash.replace(/^#\/?/, ''));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  
  return route;
}