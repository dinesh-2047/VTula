import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import dbConnect from './db';
import User from '@/models/User';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      id: 'credentials',
      name: 'Email & Password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        await dbConnect();
        const user = await User.findOne({ email: credentials.email as string });
        if (!user || !user.isActive) return null;

        const isValid = await bcrypt.compare(
          credentials.password as string,
          user.passwordHash
        );
        if (!isValid) return null;

        return {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          role: user.role,
          state: user.state || '',
          district: user.district || '',
        };
      },
    }),
    Credentials({
      id: 'phone-otp',
      name: 'Phone OTP',
      credentials: {
        phone: { label: 'Phone', type: 'text' },
        userId: { label: 'User ID', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials?.userId) return null;

        await dbConnect();
        const user = await User.findById(credentials.userId as string);
        if (!user || !user.isActive) return null;

        return {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          role: user.role,
          state: user.state || '',
          district: user.district || '',
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as unknown as { role: string }).role;
        token.state = (user as unknown as { state: string }).state;
        token.district = (user as unknown as { district: string }).district;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as unknown as { id: string }).id = token.id as string;
        (session.user as unknown as { role: string }).role = token.role as string;
        (session.user as unknown as { state: string }).state = token.state as string;
        (session.user as unknown as { district: string }).district = token.district as string;
      }
      return session;
    },
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  session: {
    strategy: 'jwt',
    maxAge: 7 * 24 * 60 * 60, // 7 days
  },
  secret: process.env.NEXTAUTH_SECRET,
});
