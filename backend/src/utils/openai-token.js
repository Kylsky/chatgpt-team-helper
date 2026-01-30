import jwt from 'jsonwebtoken'

/**
 * Parse OpenAI Access Token (JWT) to extract user info
 * @param {string} token - The access token string
 * @returns {object|null} - Parsed info { email, userId, exp } or null if invalid
 */
export function parseAccessToken(token) {
    try {
        if (!token || typeof token !== 'string') return null

        // We only need the payload, not signature verification for basic info extraction
        // Authentication should be handled by OpenAI API when we use the token
        const decoded = jwt.decode(token)
        if (!decoded) return null

        const profile = decoded['https://api.openai.com/profile'] || {}
        const auth = decoded['https://api.openai.com/auth'] || {}

        return {
            email: profile.email || null,
            userId: auth.user_id || null,
            exp: decoded.exp ? decoded.exp * 1000 : null // Convert to ms
        }
    } catch (error) {
        console.error('Error parsing access token:', error.message)
        return null
    }
}
