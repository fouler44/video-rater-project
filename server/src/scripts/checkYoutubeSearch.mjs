import "dotenv/config";
import { searchYoutube } from "../services.js";

try {
  const result = await searchYoutube("Naruto OP1 anime opening official crunchyroll tv size 1:30");
  console.log(
    JSON.stringify(
      {
        ok: true,
        items: (result.items || []).length,
        first: result.items?.[0]?.id?.videoId || null,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        message: String(error?.message || error || ""),
      },
      null,
      2,
    ),
  );
}
