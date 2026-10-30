package semiont.signin

import java.util.Locale

/** The file the launcher keeps its sign-ins in, in its state home. */
public const val FILE_NAME: String = "tokens.json"

/** The file every writer of the sign-ins locks, beside them. */
internal const val LOCK_NAME: String = "tokens.lock"

/** The systems the launcher's state home differs by: macOS, Windows, and everything else. */
public enum class Platform { MACOS, WINDOWS, OTHER }

/** The system this process runs on. */
public fun thisPlatform(): Platform {
    val name = System.getProperty("os.name").lowercase(Locale.ROOT)
    return when {
        name.startsWith("mac") -> Platform.MACOS
        name.startsWith("windows") -> Platform.WINDOWS
        else -> Platform.OTHER
    }
}

private fun under(separator: Char, base: String, vararg names: String): String = (listOf(base.trimEnd(separator)) + names).joinToString(separator.toString())

/**
 * The launcher's state home, from what the system says of the person's
 * directories (specs/src/sign-in-store/cases.json): `home` is the home
 * directory (`HOME`, or `USERPROFILE` on Windows), `xdgStateHome` is
 * `XDG_STATE_HOME` and `localAppData` is `LOCALAPPDATA`, each null when it is
 * not set. The SDK reads none of them: the application hands them in. Null
 * when there is no home. The path is written with the system's own separator,
 * not this machine's, so a case gives one answer whichever machine reads it.
 */
public fun stateDir(platform: Platform, home: String?, xdgStateHome: String?, localAppData: String?): String? {
    if (home.isNullOrEmpty()) return null
    return when (platform) {
        Platform.MACOS -> under('/', home, "Library", "Application Support", "semiont")
        Platform.WINDOWS -> if (!localAppData.isNullOrEmpty()) under('\\', localAppData, "semiont") else under('\\', home, "AppData", "Local", "semiont")
        Platform.OTHER -> if (!xdgStateHome.isNullOrEmpty()) under('/', xdgStateHome, "semiont") else under('/', home, ".local", "state", "semiont")
    }
}
