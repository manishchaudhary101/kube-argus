import { createContext, useContext } from 'react'
import type { UserInfo } from '../types'

export const AuthCtx = createContext<UserInfo>({ email: 'anonymous', role: 'viewer', authMode: 'none' })
export const useAuth = () => useContext(AuthCtx)
