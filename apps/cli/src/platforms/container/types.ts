/**
 * Container platform resources - for services running in Docker/Podman
 */
export interface ContainerResources {
  id?: string;                // Short container ID
  containerId: string;        // Full container ID
  containerName?: string;
  image?: string;             // Full image name with tag
  imageName?: string;
  imageTag?: string;
  networkId?: string;
  networkName?: string;
  volumeId?: string;          // Volume ID for persistent storage
  ports?: Record<string, string>;  // host:container port mapping
  volumes?: Array<{
    host: string;
    container: string;
    mode: 'ro' | 'rw';
  }>;
}
