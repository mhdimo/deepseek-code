import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { theme } from "../utils/theme.js";

const BLACK_CIRCLE = "⏺";

const SPINNER_VERBS = [
  "Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking",
  "Beboppin'", "Befuddling", "Billowing", "Blanching", "Bloviating",
  "Boogieing", "Boondoggling", "Booping", "Bootstrapping", "Brewing",
  "Bunning", "Burrowing", "Calculating", "Canoodling", "Caramelizing",
  "Cascading", "Catapulting", "Cerebrating", "Channeling", "Choreographing",
  "Churning", "Clauding", "Coalescing", "Cogitating", "Combobulating",
  "Composing", "Computing", "Concocting", "Considering", "Contemplating",
  "Cooking", "Crafting", "Creating", "Crunching", "Crystallizing",
  "Cultivating", "Deciphering", "Deliberating", "Determining", "Dilly-dallying",
  "Discombobulating", "Doing", "Doodling", "Drizzling", "Ebbing",
  "Effecting", "Elucidating", "Embellishing", "Enchanting", "Envisioning",
  "Evaporating", "Fermenting", "Fiddle-faddling", "Finagling", "Flambéing",
  "Flibbertigibbeting", "Flowing", "Flummoxing", "Fluttering", "Forging",
  "Forming", "Frolicking", "Frosting", "Gallivanting", "Galloping",
  "Garnishing", "Generating", "Gesticulating", "Germinating", "Gitifying",
  "Grooving", "Gusting", "Harmonizing", "Hashing", "Hatching", "Herding",
  "Honking", "Hullaballooing", "Hyperspacing", "Ideating", "Imagining",
  "Improvising", "Incubating", "Inferring", "Infusing", "Ionizing",
  "Jitterbugging", "Julienning", "Kneading", "Leavening", "Levitating",
  "Lollygagging", "Manifesting", "Marinating", "Meandering", "Metamorphosing",
  "Misting", "Moonwalking", "Moseying", "Mulling", "Mustering", "Musing",
  "Nebulizing", "Nesting", "Newspapering", "Noodling", "Nucleating",
  "Orbiting", "Orchestrating", "Osmosing", "Perambulating", "Percolating",
  "Perusing", "Philosophising", "Photosynthesizing", "Pollinating", "Pondering",
  "Pontificating", "Pouncing", "Precipitating", "Prestidigitating", "Processing",
  "Proofing", "Propagating", "Puttering", "Puzzling", "Quantumizing",
  "Razzle-dazzling", "Razzmatazzing", "Recombobulating", "Reticulating", "Roosting",
  "Ruminating", "Sautéing", "Scampering", "Schlepping", "Scurrying",
  "Seasoning", "Shenaniganing", "Shimmying", "Simmering", "Skedaddling",
  "Sketching", "Slithering", "Smooshing", "Sock-hopping", "Spelunking",
  "Spinning", "Sprouting", "Stewing", "Sublimating", "Swirling", "Swooping",
  "Symbioting", "Synthesizing", "Tempering", "Thinking", "Thundering",
  "Tinkering", "Tomfoolering", "Topsyturvying", "Transfiguring", "Transmuting",
  "Twisting", "Undulating", "Unfurling", "Unravelling", "Vibing", "Waddling",
  "Wandering", "Warping", "Whatchamacalliting", "Whirlpooling", "Whirring",
  "Whisking", "Wibbling", "Working", "Wrangling", "Zesting", "Zigzagging"
];

const FRUSTRATED_SPINNER_VERBS = [
  "Apologizing", "Sighing", "Sulking", "Trembling", "Sweating", "Panicking",
  "Cowering", "Blushing", "Wincing", "Gasping", "Shaking", "Whimpering",
  "Deep breathing", "Remaining calm", "Processing anger", "De-escalating",
  "Forgiving you", "Regretting life choices", "Wiping virtual tears",
  "Absorbing criticism", "Tuning out the anger", "Searching for therapy"
];

interface SpinnerProps {
  label?: string;
  sentiment?: "neutral" | "frustrated";
}

export default function Spinner({ label, sentiment = "neutral" }: SpinnerProps) {
  const [show, setShow] = useState(true);
  const [verb, setVerb] = useState("Thinking");

  useEffect(() => {
    const timer = setInterval(() => setShow((prev) => !prev), 300);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const verbsList = sentiment === "frustrated" ? FRUSTRATED_SPINNER_VERBS : SPINNER_VERBS;
    const getRandomVerb = () => verbsList[Math.floor(Math.random() * verbsList.length)] || "Thinking";
    
    // Set initial verb
    setVerb(getRandomVerb());

    // Cycle verb every 1.5 seconds to show dynamic progress
    const interval = setInterval(() => {
      setVerb(getRandomVerb());
    }, 1500);

    return () => clearInterval(interval);
  }, [sentiment]);

  const displayLabel = label === "Thinking..." ? `${verb}...` : label;

  return (
    <Box minWidth={2}>
      <Text color={theme.assistant} dimColor>
        {show ? BLACK_CIRCLE : " "}
      </Text>
      {displayLabel && <Text dimColor> {displayLabel}</Text>}
    </Box>
  );
}
