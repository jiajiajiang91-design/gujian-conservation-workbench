import { ArtifactService } from '../application/artifact-service'
import { DeliveryService } from '../application/delivery-service'
import { ProjectCommandService } from '../application/project-command-service'
import { ProjectPackageService } from '../application/project-package-service'
import { IndexedDbProjectRepository } from '../infrastructure/indexeddb-repository'

export const repository = new IndexedDbProjectRepository()
export const projectPackages = new ProjectPackageService(repository)
export const projectCommands = new ProjectCommandService(repository)
export const artifacts = new ArtifactService(repository)
export const deliveries = new DeliveryService(repository)

export const proxyActor = {
  id: '99000000-0000-4000-8000-000000000001',
  role: 'reviewer' as const,
}
export const proxyActorName = '代理验证员'
