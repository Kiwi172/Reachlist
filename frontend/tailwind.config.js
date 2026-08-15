export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Deep teal primary with a coral accent. Both hues stay
        // distinguishable under deuteranopia.
        brand: {
          teal: { DEFAULT: '#0F766E', dark: '#115E59', light: '#CCFBF1' },
          coral: { DEFAULT: '#E4572E', dark: '#C4441F' },
        },
      },
    },
  },
  plugins: [],
};
