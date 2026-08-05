import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'dark' | 'light';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'dark',
      setTheme: (theme) => {
        set({ theme });
        document.documentElement.classList.toggle('dark', theme === 'dark');
      },
      toggleTheme: () => {
        set((state) => {
          const newTheme = state.theme === 'dark' ? 'light' : 'dark';
          document.documentElement.classList.toggle('dark', newTheme === 'dark');
          return { theme: newTheme };
        });
      },
    }),
    {
      name: 'theme-storage',
      version: 1,
      merge: (persistedState: unknown, currentState: ThemeState) => {
        try {
          const ps = persistedState as Record<string, unknown> | null;
          if (ps && typeof ps.theme === 'string' && (ps.theme === 'dark' || ps.theme === 'light')) {
            return { ...currentState, theme: ps.theme as Theme };
          }
          return currentState;
        } catch {
          return currentState;
        }
      },
    }
  )
);
